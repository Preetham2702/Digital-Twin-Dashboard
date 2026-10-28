from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File, Body
from fastapi.responses import StreamingResponse, Response
import asyncio
import os
import json
import uuid
import time
import socket
import struct
import subprocess
import threading
from typing import Set
from dotenv import load_dotenv
import requests
from services.perf import span, record

load_dotenv()

router = APIRouter()

PRINTER_IP = os.getenv("RESIN_PRINTER_IP")
# Camera URL follows the printer IP automatically. RESIN_CAMERA_URL is an
# optional override; the printer's own VideoUrl (Cmd 386 reply) wins at runtime.
CAMERA_URL = os.getenv("RESIN_CAMERA_URL") or (f"rtsp://{PRINTER_IP}:554/" if PRINTER_IP else None)

clients: Set[WebSocket] = set()

PRINT_STATUS_MAP = {
    0:  "IDLE",
    1:  "PRINTING",
    2:  "FILE_TRANSFER",
    4:  "EXPOSURE",
    8:  "PAUSED",
    16: "STOPPING",
    17: "FINISHED",
}

# ── State (same structure as the working logger) ──────────────────────────────
state = {}
_lock = threading.Lock()
start_time = time.time()
layer_height_mm = None
_mainboard_id = None


# ── Event set by the UDP beacon listener when the printer is seen ─────────────
_printer_online_event = threading.Event()
_video_enabled_event = threading.Event()   # set when printer acks Cmd 386 with 0
_sdcp_send = None                          # callable(cmd, data) while SDCP ws is open


def _release_video():
    """Cmd 386 Enable:0 — give our stream slot back. Every Enable:1 must be paired
    with this, otherwise the printer's NumberOfVideoStreamConnected only grows."""
    if _sdcp_send:
        try:
            _sdcp_send(386, {"Enable": 0})
            print("[RESIN VIDEO] Released video stream slot (Cmd 386 Enable 0)")
        except Exception:
            pass


# ── Passive UDP beacon listener ───────────────────────────────────────────────
def _udp_beacon_listener():
    """
    Listen on UDP port 3000 for the printer's own broadcast beacons.
    Sets _printer_online_event when a packet from the configured IP arrives —
    no active polling, no hammering the printer when it's offline.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(1.0)
    try:
        sock.bind(("", 3000))
        print("[RESIN] UDP beacon listener started on port 3000")
    except OSError as e:
        print(f"[RESIN] Cannot bind UDP port 3000 ({e}) — active discovery only")
        sock.close()
        return

    while True:
        try:
            data, (addr_ip, _) = sock.recvfrom(4096)
            # Accept beacons from the configured printer IP (or any if not set)
            if PRINTER_IP and addr_ip != PRINTER_IP:
                continue
            try:
                info = json.loads(data)
                if "Data" in info and "MainboardID" in info["Data"]:
                    _printer_online_event.set()
                    continue
            except Exception:
                pass
            # Unknown packet from the right IP — still signal
            if not PRINTER_IP or addr_ip == PRINTER_IP:
                _printer_online_event.set()
        except socket.timeout:
            pass
        except Exception as e:
            print(f"[RESIN] UDP listener error: {e}")
            time.sleep(1)


# ── Get MainboardID via UDP (used after beacon detected, or on first connect) ──
def get_mainboard_id():
    print(f"[RESIN] Discovering printer at {PRINTER_IP} ...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(5)
    try:
        with span("resin", "upstream", "UDP", "discover") as sp:
            sock.sendto(b'M99999', (PRINTER_IP, 3000))
            data, _ = sock.recvfrom(4096)
            sp["status"] = "ok"
        info = json.loads(data)
        mid = info["Data"]["MainboardID"]
        print(f"[RESIN] {info['Data']['MachineName']}  |  ID: {mid}  |  FW: {info['Data']['FirmwareVersion']}")
        return mid
    except Exception as e:
        print(f"[RESIN] Discovery failed: {e}")
        return None
    finally:
        sock.close()


# ── Try to get layer height from .goo file header (exact copy from logger) ────
def try_get_layer_height(filename):
    global layer_height_mm
    if not filename or layer_height_mm is not None:
        return
    try:
        import urllib.request
        name = filename.split("/")[-1]
        url  = f"http://{PRINTER_IP}:3030/media/mmcblk0p3/{name}"
        req  = urllib.request.Request(url, headers={"Range": "bytes=0-4096"})
        data = urllib.request.urlopen(req, timeout=3).read()
        for offset in [72, 76, 80, 84, 88, 92, 96, 100]:
            if offset + 4 <= len(data):
                val = struct.unpack_from("<f", data, offset)[0]
                if 0.01 <= val <= 0.2:
                    layer_height_mm = round(val, 4)
                    print(f"[RESIN] Layer height: {layer_height_mm}mm")
                    return
    except Exception:
        pass


# ── Parse incoming WebSocket message (exact copy from logger) ─────────────────
_status_req_t0 = None   # perf: when we last asked the printer for status (SDCP cmd 0)


def parse_message(raw):
    global state, _status_req_t0
    try:
        data = json.loads(raw)
    except Exception:
        return False

    updated = False

    # Reply to Cmd 386 (video enable): Ack 0=ok, 1=too many streams, 2=no camera
    try:
        inner = data.get("Data", {})
        if inner.get("Cmd") == 386:
            ack = inner.get("Data", {}).get("Ack")
            url = inner.get("Data", {}).get("VideoUrl")
            msg = {0: "ok", 1: "max simultaneous streams reached", 2: "camera not found"}.get(ack, f"unknown ({ack})")
            print(f"[RESIN VIDEO] Cmd 386 ack: {msg}  |  printer VideoUrl: {url}  |  using: {CAMERA_URL}")
            if url:
                _set_camera_url(url if "://" in url else f"rtsp://{url}")
            if ack == 2:
                print("[RESIN VIDEO] ❌ Printer reports no camera")
                _video_enabled_event.clear()
            else:
                # Ack 1 (counter full) still streams RTSP on FW 1.5.6 — warn, don't block
                if ack == 1:
                    print("[RESIN VIDEO] ⚠️ Printer stream counter full — trying RTSP anyway")
                _video_enabled_event.set()
    except Exception:
        pass

    try:
        a = data.get("Attributes")
        if a and "NumberOfVideoStreamConnected" in a:
            print(f"[RESIN VIDEO] Printer reports {a['NumberOfVideoStreamConnected']}/"
                  f"{a.get('MaximumVideoStreamAllowed')} video streams in use, CameraStatus={a.get('CameraStatus')}")
    except Exception:
        pass

    if "Status" in data:
        # perf: round-trip from our last status request to this Status reply
        if _status_req_t0 is not None:
            record("resin", "upstream", "SDCP", "status", "ok", time.perf_counter() - _status_req_t0)
            _status_req_t0 = None
        s  = data["Status"]
        pi = s.get("PrintInfo", {})

        cs = s.get("CurrentStatus", [0])
        cs_val = cs[0] if isinstance(cs, list) else cs

        cur = pi.get("CurrentTicks", 0)
        tot = pi.get("TotalTicks", 0)
        cur_layer = pi.get("CurrentLayer", 0)

        with _lock:
            state["printer_connected"] = True
            state["elapsed_seconds"]   = round(time.time() - start_time, 1)

            state["print"] = {
                "filename":          pi.get("Filename", ""),
                "status":            PRINT_STATUS_MAP.get(cs_val, cs_val),
                "current_layer":     cur_layer,
                "total_layers":      pi.get("TotalLayer", 0),
                "progress_percent":  min(100.0, round(cur / tot * 100, 2)) if tot > 0 else 0,
                "current_ticks_ms":  cur,
                "total_ticks_ms":    tot,
                "remaining_time_ms": max(0, tot - cur) if tot > 0 else 0,
                "remaining_time_min": round(max(0, tot - cur) / 60000, 1) if tot > 0 else 0,
                "z_position_mm":     round(cur_layer * layer_height_mm, 3) if layer_height_mm and cur_layer else None,
                "error_number":      pi.get("ErrorNumber", 0),
                "task_id":           pi.get("TaskId", ""),
            }

            state["temperature"] = {
                "uvled_c":       round(s.get("TempOfUVLED", 0), 2),
                "tank_c":        s.get("TempOfTank", 0),
                "tank_target_c": s.get("TempTargetTank", 0),
            }

            state["machine_status"] = {
                "status":             PRINT_STATUS_MAP.get(cs_val, cs_val),
                "heat_on":            s.get("HeatStatus", 0) == 1,
                "timelapse_on":       s.get("TimeLapseStatus", 0) == 1,
                "print_screen_count": int(s.get("PrintScreen", 0)),
                "release_film_count": s.get("ReleaseFilm", 0),
                "release_film_max":   state.get("machine_status", {}).get("release_film_max", 60000),
            }

        try_get_layer_height(pi.get("Filename", ""))
        updated = True

    return updated


# ── Flatten nested state → flat dict for frontend ─────────────────────────────
def flatten_state() -> dict:
    with _lock:
        p  = state.get("print", {})
        t  = state.get("temperature", {})
        ms = state.get("machine_status", {})
        return {
            "printer_connected":  state.get("printer_connected", False),
            "status":             p.get("status", "Disconnected"),
            "filename":           p.get("filename", ""),
            "current_layer":      p.get("current_layer", 0),
            "total_layers":       p.get("total_layers", 0),
            "progress":           p.get("progress_percent", 0),
            "z_position_mm":      p.get("z_position_mm", 0) or 0,
            "remaining_time_min": p.get("remaining_time_min", 0),
            "uvled_temp_c":       t.get("uvled_c", 0),
            "tank_temp_c":        t.get("tank_c", 0),
            "tank_target_c":      t.get("tank_target_c", 0),
            "heat_on":            ms.get("heat_on", False),
            "timelapse_on":       ms.get("timelapse_on", False),
            "release_film_count": ms.get("release_film_count", 0),
            "release_film_max":   ms.get("release_film_max", 60000),
            "error_number":       p.get("error_number", 0),
            "elapsed_seconds":    state.get("elapsed_seconds", 0),
        }


# ── SDCP WebSocket loop (same flow as logger's run()) ─────────────────────────
def _sdcp_loop():
    global _mainboard_id, start_time, layer_height_mm, _status_req_t0, _sdcp_send

    try:
        import websocket
    except ImportError:
        print("[RESIN] websocket-client not installed — pip install websocket-client")
        return

    while True:
        layer_height_mm = None
        start_time = time.time()

        mid = get_mainboard_id()
        if mid is None:
            with _lock:
                state["printer_connected"] = False
            print("[RESIN] Printer offline — waiting for beacon (retrying every 30s) ...")
            # Wake on the printer's broadcast beacon, or retry discovery after 30s.
            # (Beacons are broadcasts and never reach a computer on a different
            # subnet, so waiting forever would leave the printer stuck offline.)
            _printer_online_event.clear()
            got_beacon = _printer_online_event.wait(timeout=30)
            _printer_online_event.clear()
            print("[RESIN] Beacon received — attempting connection ..." if got_beacon
                  else "[RESIN] Retrying discovery ...")
            time.sleep(0.5)                       # brief pause before re-querying
            continue

        _mainboard_id = mid
        ws_url = f"ws://{PRINTER_IP}:3030/websocket"

        def make_cmd(cmd_id, data=None):
            return json.dumps({
                "Id": uuid.uuid4().hex,
                "Data": {
                    "Cmd": cmd_id,
                    "Data": data or {},
                    "From": 0,
                    "MainboardID": _mainboard_id,
                    "RequestID": uuid.uuid4().hex,
                    "TimeStamp": int(time.time() * 1000)
                },
                "Topic": f"sdcp/request/{_mainboard_id}"
            })

        try:
            ws = websocket.create_connection(ws_url, timeout=10)
            print(f"[RESIN] Connected to {ws_url}")

            for cmd in [0, 1]:
                if cmd == 0:
                    _status_req_t0 = time.perf_counter()
                ws.send(make_cmd(cmd))
                time.sleep(0.2)

            _sdcp_send = lambda c, d=None: ws.send(make_cmd(c, d))

            # SDCP Cmd 386: Enable:1 reserves a stream slot, Enable:0 releases it.
            # Release first (drops a slot left by our previous run/reconnect),
            # then reserve exactly one. Reply handled in parse_message.
            if CAMERA_URL:
                _release_video()
                time.sleep(0.3)
                ws.send(make_cmd(386, {"Enable": 1}))
                print("[RESIN VIDEO] Requested video stream (Cmd 386 Enable 1)")
                time.sleep(0.2)

            ws.settimeout(3)
            _last_386 = time.time()

            while True:
                try:
                    raw = ws.recv()
                    if parse_message(raw):
                        # Instead of save_json(), broadcast() picks it up
                        pass
                except websocket.WebSocketTimeoutException:
                    _status_req_t0 = time.perf_counter()
                    ws.send(make_cmd(0))
                    # not granted -> retry every 60s, always release-then-reserve
                    # so retries never stack extra slots
                    if CAMERA_URL and not _video_enabled_event.is_set() and time.time() - _last_386 > 60:
                        _last_386 = time.time()
                        ws.send(make_cmd(1))             # refresh stream count in log
                        _release_video()
                        time.sleep(0.3)
                        ws.send(make_cmd(386, {"Enable": 1}))
                except KeyboardInterrupt:
                    return
                except Exception as e:
                    print(f"[RESIN] WS error: {e}")
                    break

        except Exception as e:
            print(f"[RESIN] Connection error: {e}")

        with _lock:
            state["printer_connected"] = False
        _video_enabled_event.clear()
        _sdcp_send = None

        print("[RESIN] Reconnecting in 5s...")
        time.sleep(5)


def _set_camera_url(url):
    """Adopt the URL the printer reports; restart ffmpeg if it changed."""
    global CAMERA_URL
    if url and url != CAMERA_URL:
        print(f"[RESIN VIDEO] Camera URL -> {url} (was {CAMERA_URL})")
        CAMERA_URL = url
        _kill_ffmpeg()          # reader loop reconnects to the new URL


# =============================
# BROADCAST TO FRONTEND
# =============================
async def broadcast():
    dead = []
    snapshot = flatten_state()
    for client in clients:
        try:
            await client.send_json(snapshot)
        except Exception:
            dead.append(client)
    for d in dead:
        clients.discard(d)


# =============================
# WEBSOCKET ENDPOINT
# =============================
@router.websocket("/ws/resin")
async def resin_ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    await websocket.send_json(flatten_state())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        clients.discard(websocket)


# =============================
# PERIODIC BROADCASTER
# =============================
async def _broadcast_loop():
    _last_snapshot: dict = {}
    while True:
        snapshot = flatten_state()
        # Only push to clients when something actually changed
        if snapshot != _last_snapshot:
            _last_snapshot = snapshot
            await broadcast()
        await asyncio.sleep(1)


# =============================
# STARTUP
# =============================
@router.on_event("startup")
async def startup_event():
    if not PRINTER_IP:
        print("[RESIN] RESIN_PRINTER_IP not set in .env — resin printer disabled")
        return
    print(f"[RESIN] Starting with PRINTER_IP={PRINTER_IP}")
    # Passive UDP beacon listener — wakes _sdcp_loop when printer comes online
    threading.Thread(target=_udp_beacon_listener, daemon=True).start()
    t = threading.Thread(target=_sdcp_loop, daemon=True)
    t.start()
    asyncio.create_task(_broadcast_loop())
    if CAMERA_URL:
        print(f"[RESIN] Starting camera snapshots from {CAMERA_URL}")
        cam = threading.Thread(target=_snapshot_loop, daemon=True)
        cam.start()


# =============================
# START / PAUSE / STOP
# =============================
@router.post("/start")
async def start(dummy: dict = Body(default={})):
    state["print"] = {**state.get("print", {}), "status": "Printing"}
    return {"status": True}


@router.post("/pause")
async def pause(dummy: dict = Body(default={})):
    state["print"] = {**state.get("print", {}), "status": "Paused"}
    return {"status": True}


@router.post("/stop")
async def stop(dummy: dict = Body(default={})):
    state["print"] = {**state.get("print", {}), "status": "Stopped", "progress_percent": 0}
    return {"status": True}


# =============================
# FILE UPLOAD
# =============================
@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    contents = await file.read()
    files = {"file": (file.filename, contents, "application/octet-stream")}
    try:
        with span("resin", "upstream", "POST", "/uploadFile/upload") as sp:
            res = requests.post(
                f"http://{PRINTER_IP}:3030/uploadFile/upload",
                files=files,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=20,
            )
            sp["status"] = res.status_code
        print("[RESIN] Upload response:", res.text)
        return {"success": res.ok}
    except Exception as e:
        print(f"[RESIN] Upload error: {e}")
        return {"success": False}


# =============================
# CAMERA PREVIEW (single persistent RTSP session)
# =============================
# One long-lived ffmpeg process holds ONE of the printer's 2 RTSP slots and
# emits ~2 JPEGs/s on stdout. Reconnecting every second (old approach) forced a
# fresh RTSP handshake + keyframe wait per frame and leaked slots when ffmpeg
# was killed mid-session, which is what made the preview flaky.
import atexit

_latest_frame = None
_latest_frame_ts = 0.0
_frame_lock = threading.Lock()
_ffmpeg_proc = None

PREVIEW_FPS = 10         # frames/s pushed to the browser
_frame_seq = 0           # increments per frame; stream endpoint waits on it
FRAME_STALE_SEC = 10     # /preview returns 503 if newest frame is older than this
WATCHDOG_SEC = 15        # restart ffmpeg if no frame for this long


def _kill_ffmpeg():
    global _ffmpeg_proc
    p = _ffmpeg_proc
    _ffmpeg_proc = None
    if p and p.poll() is None:
        p.terminate()                      # lets ffmpeg send RTSP TEARDOWN
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()


def _shutdown_camera():
    _kill_ffmpeg()
    _release_video()


atexit.register(_shutdown_camera)


@router.on_event("shutdown")
async def _on_shutdown():
    # runs on Ctrl+C and on every --reload restart, before the process dies
    _shutdown_camera()


def _start_ffmpeg():
    return subprocess.Popen(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            # low-latency input: no input buffering, don't hold packets for reordering
            "-fflags", "nobuffer", "-flags", "low_delay",
            "-max_delay", "200000", "-reorder_queue_size", "0",
            # Saturn 4 Ultra only offers RTP over UDP (TCP -> "Nonmatching transport").
            "-rtsp_transport", os.getenv("RESIN_RTSP_TRANSPORT", "udp"),
            "-buffer_size", "1048576",         # bigger UDP buffer -> fewer dropped packets on Wi-Fi
            "-timeout", "5000000",             # 5s socket timeout (µs)
            "-i", CAMERA_URL,
            "-an",
            "-vf", f"fps={PREVIEW_FPS}",
            "-q:v", "5",
            "-f", "image2pipe", "-vcodec", "mjpeg",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


_KEYFRAME_NOISE = ("non-existing PPS", "no frame!", "Last message repeated",
                   "RTP: missed", "max delay reached", "decode_slice_header error")


def _stderr_drain(proc):
    # Joining mid-GOP makes the H.264 decoder complain until the next keyframe
    # (can take ~10-20s on this camera). Log that once instead of spamming.
    warned = False
    for line in iter(proc.stderr.readline, b""):
        msg = line.decode(errors="replace").strip()
        if any(n in msg for n in _KEYFRAME_NOISE):
            if not warned:
                print("[RESIN VIDEO] Waiting for first keyframe from camera ...")
                warned = True
            continue
        print(f"[RESIN VIDEO] ffmpeg: {msg}")


def _snapshot_loop():
    """Background thread: keep one ffmpeg alive, split its MJPEG output into frames."""
    global _latest_frame, _latest_frame_ts, _ffmpeg_proc, _frame_seq
    backoff = 2
    while True:
        if not _video_enabled_event.is_set():
            print("[RESIN VIDEO] Waiting for Cmd 386 reply (max 15s) ...")
            _video_enabled_event.wait(timeout=15)
            backoff = 2
        print(f"[RESIN VIDEO] Opening RTSP session {CAMERA_URL}")
        proc = _start_ffmpeg()
        _ffmpeg_proc = proc
        threading.Thread(target=_stderr_drain, args=(proc,), daemon=True).start()

        last_frame_at = time.time()
        frames = 0
        buf = b""

        # watchdog: kill ffmpeg if it stalls (stdout.read would block forever)
        def _watchdog():
            while proc.poll() is None:
                if time.time() - last_frame_at > WATCHDOG_SEC:
                    print(f"[RESIN VIDEO] ❌ No frame for {WATCHDOG_SEC}s — restarting ffmpeg")
                    _kill_ffmpeg()
                    return
                time.sleep(1)
        threading.Thread(target=_watchdog, daemon=True).start()

        try:
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    soi = buf.find(b"\xff\xd8")
                    eoi = buf.find(b"\xff\xd9", soi + 2) if soi != -1 else -1
                    if soi == -1 or eoi == -1:
                        if len(buf) > 5_000_000:      # garbage guard
                            buf = b""
                        break
                    frame = buf[soi:eoi + 2]
                    buf = buf[eoi + 2:]
                    with _frame_lock:
                        _latest_frame = frame
                        _latest_frame_ts = time.time()
                        _frame_seq += 1
                    last_frame_at = time.time()
                    frames += 1
                    backoff = 2
                    if frames == 1:
                        print(f"[RESIN VIDEO] ✅ First frame ({len(frame)} bytes)")
                    elif frames % 120 == 0:
                        print(f"[RESIN VIDEO] ✅ {frames} frames on this session")
        except Exception as e:
            print(f"[RESIN VIDEO] ❌ Reader error: {e}")

        if _ffmpeg_proc is proc:
            _kill_ffmpeg()
        else:
            try:
                proc.wait(timeout=3)
            except Exception:
                pass
        print(f"[RESIN VIDEO] Session ended after {frames} frames (exit {proc.returncode}) — retry in {backoff}s")
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)


@router.get("/preview")
async def preview():
    """Return the latest camera frame as JPEG (503 if none / stale)."""
    if not CAMERA_URL:
        return Response(status_code=503)

    with _frame_lock:
        frame, ts = _latest_frame, _latest_frame_ts

    if frame and time.time() - ts < FRAME_STALE_SEC:
        return Response(content=frame, media_type="image/jpeg",
                        headers={"Cache-Control": "no-store"})
    return Response(status_code=503)


@router.get("/preview/stream")
async def preview_stream():
    """MJPEG push stream: each new frame is sent the moment ffmpeg produces it
    (no browser polling delay). Every viewer shares the ONE RTSP session."""
    if not CAMERA_URL:
        return Response(status_code=503)

    async def gen():
        last = -1
        while True:
            with _frame_lock:
                seq, frame, ts = _frame_seq, _latest_frame, _latest_frame_ts
            if seq != last and frame and time.time() - ts < FRAME_STALE_SEC:
                last = seq
                yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                       + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
            # if the camera drops, keep the HTTP stream open; frames resume
            # automatically once ffmpeg reconnects (no browser reconnect needed)
            await asyncio.sleep(0.03)

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store"})
