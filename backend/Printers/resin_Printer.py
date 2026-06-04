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

load_dotenv()

router = APIRouter()

PRINTER_IP = os.getenv("RESIN_PRINTER_IP")
CAMERA_URL = os.getenv("RESIN_CAMERA_URL")  # e.g. rtsp://10.106.89.35:554/

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


# ── Get MainboardID via UDP (exact copy from logger) ──────────────────────────
def get_mainboard_id():
    print(f"[RESIN] Discovering printer at {PRINTER_IP} ...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(5)
    try:
        sock.sendto(b'M99999', (PRINTER_IP, 3000))
        data, _ = sock.recvfrom(4096)
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
def parse_message(raw):
    global state
    try:
        data = json.loads(raw)
    except Exception:
        return False

    updated = False

    if "Status" in data:
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
                "progress_percent":  round(cur / tot * 100, 2) if tot > 0 else 0,
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
    global _mainboard_id, start_time, layer_height_mm

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
            time.sleep(5)
            continue

        _mainboard_id = mid
        ws_url = f"ws://{PRINTER_IP}:3030/websocket"

        def make_cmd(cmd_id):
            return json.dumps({
                "Id": uuid.uuid4().hex,
                "Data": {
                    "Cmd": cmd_id,
                    "Data": {},
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
                ws.send(make_cmd(cmd))
                time.sleep(0.2)

            ws.settimeout(3)

            while True:
                try:
                    raw = ws.recv()
                    if parse_message(raw):
                        # Instead of save_json(), broadcast() picks it up
                        pass
                except websocket.WebSocketTimeoutException:
                    ws.send(make_cmd(0))
                except KeyboardInterrupt:
                    return
                except Exception as e:
                    print(f"[RESIN] WS error: {e}")
                    break

        except Exception as e:
            print(f"[RESIN] Connection error: {e}")

        with _lock:
            state["printer_connected"] = False

        print("[RESIN] Reconnecting in 5s...")
        time.sleep(5)


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
    while True:
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
    t = threading.Thread(target=_sdcp_loop, daemon=True)
    t.start()
    asyncio.create_task(_broadcast_loop())


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
        res = requests.post(
            f"http://{PRINTER_IP}:3030/uploadFile/upload",
            files=files,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=20,
        )
        print("[RESIN] Upload response:", res.text)
        return {"success": res.ok}
    except Exception as e:
        print(f"[RESIN] Upload error: {e}")
        return {"success": False}


# =============================
# CAMERA PREVIEW (RTSP → MJPEG)
# =============================
def _ffmpeg_mjpeg_generator():
    """Run FFmpeg to convert RTSP stream into JPEG frames, yield as multipart MJPEG."""
    cmd = [
        "ffmpeg",
        "-i", CAMERA_URL,
        "-f", "mjpeg",
        "-q:v", "5",
        "-r", "10",
        "pipe:1",
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    try:
        buf = b""
        while True:
            chunk = proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk

            # Find complete JPEG frames (FFD8 start → FFD9 end)
            while True:
                start = buf.find(b"\xff\xd8")
                if start < 0:
                    buf = b""
                    break
                end = buf.find(b"\xff\xd9", start + 2)
                if end < 0:
                    # Keep from start marker onward, wait for more data
                    buf = buf[start:]
                    break
                frame = buf[start:end + 2]
                buf = buf[end + 2:]
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
                    + frame + b"\r\n"
                )
    finally:
        proc.kill()
        proc.wait()


@router.get("/preview")
async def preview():
    """Proxy RTSP camera stream as MJPEG for the browser."""
    if not CAMERA_URL:
        print("[RESIN] RESIN_CAMERA_URL not set in .env")
        return Response(status_code=503)

    return StreamingResponse(
        _ffmpeg_mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )