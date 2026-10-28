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
from Printers.resin_goo import (parse_goo_header, goo_preview_png, HEADER_BYTES,
                                index_layers, render_layer_png, read_layer_settings,
                                layer_cured_pixels, decode_layer_grid, find_unsupported_islands)

load_dotenv()

router = APIRouter()

PRINTER_IP = os.getenv("RESIN_PRINTER_IP")
# Camera URL follows the printer IP automatically. RESIN_CAMERA_URL is an
# optional override; the printer's own VideoUrl (Cmd 386 reply) wins at runtime.
CAMERA_URL = os.getenv("RESIN_CAMERA_URL") or (f"rtsp://{PRINTER_IP}:554/" if PRINTER_IP else None)
# RESIN_CAMERA_RELAY=1: the camera is read through a relay (e.g. MediaMTX) that holds the
# printer's stream slot permanently. Then the backend must not take over the printer's URL
# or send Cmd 386 Enable:0 (that could switch the stream off for the relay).
CAMERA_RELAY = os.getenv("RESIN_CAMERA_RELAY", "").lower() in ("1", "true", "yes")

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

# SDCP PrintInfo.ErrorNumber
PRINT_ERROR_MAP = {
    0: None,
    1: "File MD5 check failed",
    2: "File read failed",
    3: "Resolution mismatch — file not sliced for this printer",
    4: "File format mismatch",
    5: "Machine model mismatch — file sliced for a different printer",
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
_video_slots = {"ack": None, "used": None, "max": None}   # last Cmd 386 ack + stream counter
_sdcp_send = None                          # callable(cmd, data) while SDCP ws is open
_sdcp_ws = None                            # live websocket (for request/response calls)
_ws_send_lock = threading.Lock()
_pending: dict = {}                        # RequestID -> {"event": Event, "data": dict}


def sdcp_request(cmd: int, data: dict | None = None, timeout: float = 6.0) -> dict:
    """Send an SDCP command and block until the printer's response with the same
    RequestID arrives. Returns the response Data dict (contains "Ack")."""
    ws = _sdcp_ws
    if ws is None or not _mainboard_id:
        raise RuntimeError("Resin printer not connected")
    rid = uuid.uuid4().hex
    slot = {"event": threading.Event(), "data": None}
    _pending[rid] = slot
    msg = json.dumps({
        "Id": uuid.uuid4().hex,
        "Data": {"Cmd": cmd, "Data": data or {}, "From": 0, "MainboardID": _mainboard_id,
                 "RequestID": rid, "TimeStamp": int(time.time() * 1000)},
        "Topic": f"sdcp/request/{_mainboard_id}",
    })
    try:
        with span("resin", "upstream", "SDCP", f"cmd {cmd}") as sp:
            with _ws_send_lock:
                ws.send(msg)
            if not slot["event"].wait(timeout):
                sp["status"] = "timeout"
                raise TimeoutError(f"No reply to SDCP Cmd {cmd}")
            sp["status"] = "ok"
        return slot["data"] or {}
    finally:
        _pending.pop(rid, None)


def _release_video():
    """Cmd 386 Enable:0 — give our stream slot back. Every Enable:1 must be paired
    with this, otherwise the printer's NumberOfVideoStreamConnected only grows."""
    if CAMERA_RELAY:
        return                              # relay owns the printer's stream; leave it on
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
_header_fetching: set = set()


def try_get_layer_height(filename):
    global layer_height_mm
    if not filename or layer_height_mm is not None:
        return
    # parsed .goo header (preferred). Never block the SDCP loop on a download:
    # fetch in the background, pick it up on a later status message.
    base = filename.rsplit("/", 1)[-1]
    if base not in _file_cache:
        if base not in _header_fetching and time.time() - _fetch_failed_at.get(base, 0) > 60:
            _header_fetching.add(base)
            threading.Thread(target=lambda: (_file_info_cached(filename), _header_fetching.discard(base)),
                             daemon=True).start()
        return
    info = _file_info_cached(filename, fetch=False)
    if info and info.get("layer_height_mm"):
        layer_height_mm = info["layer_height_mm"]
        print(f"[RESIN] Layer height: {layer_height_mm}mm (from .goo header)")
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

    # Resolve any blocking sdcp_request() waiting on this RequestID
    try:
        inner = data.get("Data", {})
        rid = inner.get("RequestID")
        if rid and rid in _pending:
            _pending[rid]["data"] = inner.get("Data", {})
            _pending[rid]["event"].set()
    except Exception:
        pass

    # Reply to Cmd 386 (video enable): Ack 0=ok, 1=too many streams, 2=no camera
    try:
        inner = data.get("Data", {})
        if inner.get("Cmd") == 386:
            ack = inner.get("Data", {}).get("Ack")
            url = inner.get("Data", {}).get("VideoUrl")
            _video_slots["ack"] = ack
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
            _video_slots.update(used=a["NumberOfVideoStreamConnected"], max=a.get("MaximumVideoStreamAllowed"))
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
        _vat_track(PRINT_STATUS_MAP.get(cs_val, cs_val), pi.get("Filename", ""),
                   pi.get("TaskId", ""), round(cur / tot * 100, 2) if tot > 0 else 0,
                   cur_layer, pi.get("TotalLayer", 0), pi.get("ErrorNumber", 0))
        updated = True

    return updated


# ── Vat resin tracker ─────────────────────────────────────────────────────────
# The printer doesn't report resin level, so we estimate it: the user logs
# refills, and each finished/stopped job subtracts its .goo volume × progress.
# Persisted to backend/resin_vat.json so it survives restarts.
from pathlib import Path as _Path

VAT_FILE = _Path(__file__).resolve().parent.parent / "resin_vat.json"
_vat_lock = threading.Lock()


def _vat_load() -> dict:
    try:
        return json.loads(VAT_FILE.read_text())
    except Exception:
        return {"ml": None, "low_ml": 50, "log": [], "deducted": []}


_vat = _vat_load()
_job = {"task_id": None, "file": "", "max_progress": 0.0, "layer_ts": {}, "started": 0.0,
        "vat_before": None, "max_error": 0, "max_layer": 0, "total_layers": 0, "last_status": "",
        "first_progress": None}


def _vat_save():
    try:
        VAT_FILE.write_text(json.dumps(_vat, indent=2))
    except Exception as e:
        print(f"[RESIN VAT] ❌ Save failed: {e}")


def _vat_log(kind: str, ml: float, note: str = ""):
    _vat.setdefault("log", []).append({"t": int(time.time()), "kind": kind, "ml": round(ml, 2), "note": note})
    _vat["log"] = _vat["log"][-200:]


def _vat_deduct_job():
    """Subtract the finished/stopped job's resin (once per task id)."""
    tid, fname, prog = _job["task_id"], _job["file"], _job["max_progress"]
    if not tid or not fname or prog <= 0 or tid in _vat.get("deducted", []):
        return
    info = _file_info_cached(fname, fetch=False)
    _vat.setdefault("deducted", []).append(tid)
    _vat["deducted"] = _vat["deducted"][-100:]
    if not info or not info.get("volume_ml"):
        print(f"[RESIN VAT] ⚠️ No resin volume known for {fname} — not deducted")
        _vat_save()
        return
    used = info["volume_ml"] * min(100.0, prog) / 100.0
    if _vat.get("ml") is not None:
        _vat["ml"] = round(max(0.0, _vat["ml"] - used), 1)
    _vat_log("print", -used, f"{fname.rsplit('/', 1)[-1]} ({prog:.0f}%)")
    _vat_save()
    print(f"[RESIN VAT] 🧪 -{used:.1f} ml for {fname.rsplit('/', 1)[-1]} ({prog:.0f}%) → vat ~{_vat.get('ml')} ml")


def _vat_track(status, filename: str, task_id: str, progress: float,
               layer: int = 0, total_layers: int = 0, error: int = 0):
    with _vat_lock:
        st = str(status).upper()
        if task_id and task_id != _job["task_id"]:
            _job_end()                             # previous job (if any) is over
            _job.update(task_id=task_id, file=filename, max_progress=0.0, layer_ts={},
                        started=time.time(), vat_before=_vat.get("ml"), max_error=0,
                        max_layer=0, total_layers=total_layers, first_progress=progress)
        if task_id == _job["task_id"]:
            _job["max_progress"] = max(_job["max_progress"], progress or 0)
            if filename:
                _job["file"] = filename
            if total_layers:
                _job["total_layers"] = total_layers
            if error:
                _job["max_error"] = error
            if layer and st in ("PRINTING", "EXPOSURE") and layer not in _job["layer_ts"]:
                _job["layer_ts"][layer] = time.time()          # when each layer started
                _job["max_layer"] = max(_job["max_layer"], layer)
            _job["last_status"] = st
        if st in ("FINISHED", "STOPPED", "IDLE"):
            _job_end()


REPORT_DIR = _Path(__file__).resolve().parent.parent / "resin_reports"


def _job_end():
    """Deduct resin and write the print report (once per task id)."""
    tid = _job["task_id"]
    already = tid in _vat.get("deducted", [])
    _vat_deduct_job()
    if not tid or already or _job["max_progress"] <= 0:
        return
    try:
        REPORT_DIR.mkdir(exist_ok=True)
        fname = _job["file"].rsplit("/", 1)[-1]
        info = _file_info_cached(_job["file"], fetch=False) or {}
        prof = _area_profiles.get(fname, {})
        ts = sorted(_job["layer_ts"].items())
        durs = [b[1] - a[1] for a, b in zip(ts, ts[1:])]
        cum = prof.get("cum_s") or []
        plan = [cum[l2 - 1] - cum[l1 - 1] for (l1, _), (l2, _) in zip(ts, ts[1:])
                if cum and l2 - 1 < len(cum)]
        used = info.get("volume_ml", 0) * min(100.0, _job["max_progress"]) / 100.0 if info else None
        finished = _job["last_status"] == "FINISHED" or _job["max_progress"] >= 99
        report = {
            "task_id": tid,
            "file": fname,
            "result": "finished" if finished else "stopped",
            "started": int(_job["started"]),
            "ended": int(time.time()),
            "duration_s": int(time.time() - _job["started"]),
            "partial_tracking": (_job["first_progress"] or 0) > 1,   # backend started mid-print
            "progress": round(_job["max_progress"], 1),
            "layers_done": _job["max_layer"],
            "layers_total": _job["total_layers"] or info.get("layer_count"),
            "resin_used_ml": round(used, 1) if used is not None else None,
            "vat_before_ml": _job["vat_before"],
            "vat_after_ml": _vat.get("ml"),
            "largest_layer": prof.get("max_layer"),
            "largest_area_mm2": prof.get("max_area"),
            "unsupported_island_layers": len(prof.get("islands") or []),
            "peel_jumps": len(prof.get("peel") or []),
            "max_error": _job["max_error"],
            "avg_layer_s": round(sum(durs) / len(durs), 2) if durs else None,
            "planned_avg_layer_s": round(sum(plan) / len(plan), 2) if plan else None,
            "slowest_layer_s": round(max(durs), 1) if durs else None,
        }
        (REPORT_DIR / f"{int(time.time())}_{tid}.json").write_text(json.dumps(report, indent=2))
        print(f"[RESIN REPORT] 📝 {fname}: {report['result']} after {report['duration_s'] // 60} min")
    except Exception as e:
        print(f"[RESIN REPORT] ❌ {e}")


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
            "error_message":      PRINT_ERROR_MAP.get(p.get("error_number", 0), f"Printer error code {p.get('error_number')}"),
            "print_screen_count": ms.get("print_screen_count", 0),
            "elapsed_seconds":    state.get("elapsed_seconds", 0),
            "vat_ml":             _vat.get("ml"),
            "vat_low_ml":         _vat.get("low_ml", 50),
        }


# ── SDCP WebSocket loop (same flow as logger's run()) ─────────────────────────
def _sdcp_loop():
    global _mainboard_id, start_time, layer_height_mm, _status_req_t0, _sdcp_send, _sdcp_ws

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

            def _locked_send(c, d=None):
                with _ws_send_lock:
                    ws.send(make_cmd(c, d))
            _sdcp_send = _locked_send
            _sdcp_ws = ws

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
                    _locked_send(0)
                    # not granted -> retry every 60s, always release-then-reserve
                    # so retries never stack extra slots
                    if CAMERA_URL and not _video_enabled_event.is_set() and time.time() - _last_386 > 60:
                        _last_386 = time.time()
                        ws.send(make_cmd(1))             # refresh stream count in log
                        _release_video()
                        time.sleep(0.3)
                        _locked_send(386, {"Enable": 1})
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
        _sdcp_ws = None

        print("[RESIN] Reconnecting in 5s...")
        time.sleep(5)


def _set_camera_url(url):
    """Adopt the URL the printer reports; restart ffmpeg if it changed."""
    global CAMERA_URL
    if CAMERA_RELAY:
        return                              # keep reading from the relay
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
import signal as _signal
_shutting_down = threading.Event()


def _install_shutdown_hook():
    """Uvicorn waits for open HTTP responses before exiting, and the MJPEG camera
    stream never ends by itself — so Ctrl+C would hang. Wrap uvicorn's SIGINT/SIGTERM
    handlers: flag shutdown (ends the streams), stop ffmpeg + release the printer's
    stream slot, then hand over to uvicorn as normal."""
    for sig in (_signal.SIGINT, _signal.SIGTERM):
        prev = _signal.getsignal(sig)

        def handler(signum, frame, _prev=prev):
            if not _shutting_down.is_set():
                _shutting_down.set()
                print("[RESIN] Shutting down — closing camera streams")
                threading.Thread(target=_shutdown_camera, daemon=True).start()
            if callable(_prev):
                _prev(signum, frame)
            elif _prev == _signal.SIG_DFL:
                raise KeyboardInterrupt
        try:
            _signal.signal(sig, handler)
        except ValueError:
            pass                                   # not in main thread (e.g. some test runners)


@router.on_event("startup")
async def startup_event():
    _install_shutdown_hook()
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
# FILES + PRINT CONTROL  (real SDCP commands, all under /resin/*)
# =============================
# NOTE: these used to be /start /pause /stop /upload, which collided with the
# FDM router (registered first) — the resin buttons were driving the Voron.
from fastapi import HTTPException, Query
import hashlib

START_ACK = {0: "ok", 1: "printer busy", 2: "file not found", 3: "MD5 check failed",
             4: "file read failed", 5: "resolution mismatch", 6: "unknown file format",
             7: "machine model mismatch"}
CTRL_ACK = {0: "ok", 1: "not allowed in current state"}


def _call(cmd, data=None, timeout=6.0):
    try:
        return sdcp_request(cmd, data, timeout)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except TimeoutError as e:
        raise HTTPException(504, str(e))


@router.get("/resin/files")
def resin_files(path: str = Query("/local/")):
    """Cmd 258 — list files on the printer (/local/ = internal storage, /usb/ = USB)."""
    r = _call(258, {"Url": path})
    raw = r.get("FileList") or []
    files = []
    for f in raw:
        name = f.get("name", "")
        files.append({
            "path": name,
            "name": name.rsplit("/", 1)[-1],
            "is_folder": f.get("type") == 0,
            "size": f.get("usedSize") or f.get("size") or 0,
        })
    print(f"[RESIN FILES] {len(files)} item(s) in {path}")
    return {"ack": r.get("Ack"), "path": path, "files": files}


@router.post("/resin/print")
def resin_print(filename: str = Query(...), start_layer: int = 0):
    """Cmd 128 — start printing a file already on the printer."""
    r = _call(128, {"Filename": filename, "StartLayer": start_layer})
    ack = r.get("Ack")
    if ack == 2 and "/" in filename:                      # some FW want bare name
        r = _call(128, {"Filename": filename.rsplit("/", 1)[-1], "StartLayer": start_layer})
        ack = r.get("Ack")
    msg = START_ACK.get(ack, f"ack {ack}")
    print(f"[RESIN CTRL] ▶ Start {filename}: {msg}")
    return {"success": ack == 0, "ack": ack, "message": msg}


def _ctrl(cmd, label):
    r = _call(cmd)
    ack = r.get("Ack")
    msg = CTRL_ACK.get(ack, f"ack {ack}")
    print(f"[RESIN CTRL] {label}: {msg}")
    return {"success": ack == 0, "ack": ack, "message": msg}


@router.post("/resin/pause")
def resin_pause():
    return _ctrl(129, "⏸ Pause")


@router.post("/resin/stop")
def resin_stop():
    return _ctrl(130, "■ Stop")


@router.post("/resin/resume")
def resin_resume():
    return _ctrl(131, "⏵ Resume")


@router.post("/resin/timelapse")
def resin_timelapse(on: bool = Query(...)):
    """Cmd 387 — turn timelapse recording on/off."""
    r = _call(387, {"Enable": 1 if on else 0})
    ack = r.get("Ack")
    if ack == 0:
        with _lock:                                   # reflect immediately in the UI
            state.setdefault("machine_status", {})["timelapse_on"] = on
    print(f"[RESIN CTRL] 🎞 Timelapse {'ON' if on else 'OFF'}: ack {ack}")
    return {"success": ack == 0, "ack": ack, "message": "ok" if ack == 0 else f"ack {ack}"}


@router.delete("/resin/files")
def resin_delete(filename: str = Query(...)):
    """Cmd 259 — delete one file."""
    r = _call(259, {"FileList": [filename], "FolderList": []})
    ack = r.get("Ack")
    print(f"[RESIN FILES] 🗑 Delete {filename}: ack {ack}")
    return {"success": ack == 0, "ack": ack}


@router.post("/resin/upload")
async def resin_upload(file: UploadFile = File(...)):
    """SDCP HTTP upload: 1 MB chunks to :3030/uploadFile/upload with whole-file MD5."""
    contents = await file.read()
    total = len(contents)
    md5 = hashlib.md5(contents).hexdigest()
    up_id = uuid.uuid4().hex
    chunk = 1024 * 1024

    def _send():
        for off in range(0, total, chunk):
            part = contents[off:off + chunk]
            res = requests.post(
                f"http://{PRINTER_IP}:3030/uploadFile/upload",
                data={"S-File-MD5": md5, "Check": "1", "Offset": str(off),
                      "Uuid": up_id, "TotalSize": str(total)},
                files={"File": (file.filename, part, "application/octet-stream")},
                timeout=30,
            )
            body = {}
            try:
                body = res.json()
            except Exception:
                pass
            if not res.ok or body.get("success") is False:
                return False, f"chunk @{off}: HTTP {res.status_code} {res.text[:200]}"
            print(f"[RESIN UPLOAD] {min(off + chunk, total)}/{total} bytes")
        return True, "ok"

    try:
        with span("resin", "upstream", "POST", "/uploadFile/upload") as sp:
            ok, msg = await asyncio.to_thread(_send)
            sp["status"] = 200 if ok else "fail"
    except Exception as e:
        ok, msg = False, str(e)
    print(f"[RESIN UPLOAD] {'✅' if ok else '❌'} {file.filename}: {msg}")
    if ok:
        _cache_header(file.filename, contents[:HEADER_BYTES])
        if file.filename.lower().endswith(".goo"):
            _store_full_file(file.filename, contents)
    return {"success": ok, "message": msg}


# =============================
# FILE DETAILS / THUMBNAILS (.goo header) + PRINT HISTORY
# =============================
_file_cache: dict = {}          # basename -> {"info": dict|None, "png": bytes|None}
_file_url: dict = {}            # basename -> printer URL that served it


def _cache_header(name: str, header: bytes):
    base = name.rsplit("/", 1)[-1]
    info = parse_goo_header(header) if base.lower().endswith(".goo") else None
    png = goo_preview_png(header) if info else None
    _file_cache[base] = {"info": info, "png": png}
    print(f"[RESIN FILES] {'✅ Parsed' if info else '⚠️ No .goo header for'} {base}")
    return _file_cache[base]


def _fetch_header(name: str) -> bytes | None:
    """Range-download the first ~196 KB of a file from the printer's HTTP server.
    The storage path differs between firmwares, so try the known layouts and
    log what each one returned."""
    from urllib.parse import quote
    base = name.rsplit("/", 1)[-1]
    q = quote(base)
    candidates = [
        f"http://{PRINTER_IP}:3030/local/{q}",
        f"http://{PRINTER_IP}:3030/media/mmcblk0p1/{q}",
        f"http://{PRINTER_IP}:3030/media/mmcblk0p3/{q}",
        f"http://{PRINTER_IP}:3030/media/{q}",
        f"http://{PRINTER_IP}:3030{quote(name)}" if name.startswith("/") else None,
        f"http://{PRINTER_IP}/local/{q}",
    ]
    tried = []
    for url in dict.fromkeys(filter(None, candidates)):
        try:
            r = requests.get(url, headers={"Range": f"bytes=0-{HEADER_BYTES - 1}"}, timeout=6, stream=True)
            data = r.raw.read(HEADER_BYTES, decode_content=True) if r.status_code in (200, 206) else b""
            r.close()
            tried.append(f"{r.status_code}:{len(data)}B")
            if len(data) >= 1000 and data[4:12] == b"\x07\x00\x00\x00DLP\x00":
                print(f"[RESIN FILES] ✅ Header fetched via {url}")
                _file_url[base] = url
                return data
        except Exception as e:
            tried.append(type(e).__name__)
    print(f"[RESIN FILES] ❌ Could not download header for {base}")
    for url, res in zip(dict.fromkeys(filter(None, candidates)), tried):
        print(f"[RESIN FILES]    {res:>14}  {url}")
    return None


_fetch_failed_at: dict = {}     # basename -> time of last failed download (retry after 60s)


def _file_info_cached(name: str, fetch: bool = True) -> dict | None:
    base = (name or "").rsplit("/", 1)[-1]
    if not base:
        return None
    recently_failed = time.time() - _fetch_failed_at.get(base, 0) < 60
    if base not in _file_cache and fetch and base.lower().endswith(".goo") and not recently_failed:
        hdr = _fetch_header(name)
        if hdr:
            _cache_header(name, hdr)
            _fetch_failed_at.pop(base, None)
        else:
            _fetch_failed_at[base] = time.time()      # don't cache the failure forever
    return (_file_cache.get(base) or {}).get("info")


@router.get("/resin/file-info")
def resin_file_info(filename: str = Query(...)):
    info = _file_info_cached(filename)
    base = filename.rsplit("/", 1)[-1]
    has_thumb = bool((_file_cache.get(base) or {}).get("png"))
    return {"filename": base, "info": info, "has_thumbnail": has_thumb}


@router.get("/resin/thumbnail")
def resin_thumbnail(filename: str = Query(...)):
    _file_info_cached(filename)
    png = (_file_cache.get(filename.rsplit("/", 1)[-1]) or {}).get("png")
    if not png:
        return Response(status_code=404)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


HISTORY_STATUS = {0: "other", 1: "completed", 2: "failed", 3: "stopped"}


@router.get("/resin/history")
def resin_history(limit: int = 20):
    """Cmd 320 (task ids) -> Cmd 321 (details)."""
    ids = _call(320).get("HistoryData") or []
    ids = ids[-limit:][::-1] if ids else []           # newest first (printer lists oldest->newest)
    if not ids:
        return {"items": []}
    det = _call(321, {"Id": ids}, timeout=10).get("HistoryDetailList") or []
    items = []
    for d in det:
        b, e = d.get("BeginTime") or 0, d.get("EndTime") or 0
        items.append({
            "task_id": d.get("TaskId"),
            "name": (d.get("TaskName") or "").rsplit("/", 1)[-1],
            "begin": b,
            "end": e,
            "duration_s": max(0, e - b) if b and e else None,
            "status": HISTORY_STATUS.get(d.get("TaskStatus"), str(d.get("TaskStatus"))),
            "layers_done": d.get("AlreadyPrintLayer"),
            "thumbnail": d.get("Thumbnail") or None,
            "error_reason": d.get("ErrorStatusReason"),
            "timelapse_url": d.get("TimeLapseVideoUrl") or None,
        })
    items.sort(key=lambda x: x["begin"] or 0, reverse=True)
    print(f"[RESIN HISTORY] {len(items)} job(s)")
    return {"items": items}


# =============================
# LIVE LAYER VIEW (full .goo cached locally, layers decoded on demand)
# =============================
from pathlib import Path
from collections import OrderedDict

CACHE_DIR = Path(__file__).resolve().parent.parent / "resin_cache"
CACHE_KEEP = 5                                   # keep the 5 most recent files
_dl: dict = {}                                   # basename -> {"state", "done", "total", "error"}
_layer_index: dict = {}                          # basename -> [(offset, len, z)]
_layer_png: "OrderedDict[tuple, bytes]" = OrderedDict()   # (base, layer) -> png (LRU)


def _cache_path(base: str) -> Path:
    return CACHE_DIR / base


def _prune_cache():
    files = sorted((p for p in CACHE_DIR.glob("*") if p.is_file() and not p.name.endswith((".part", ".json"))),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[CACHE_KEEP:]:
        try:
            old.unlink()
            _layer_index.pop(old.name, None)
            for side in CACHE_DIR.glob(old.name + ".*.json"):
                side.unlink()
            print(f"[RESIN LAYER] 🧹 Removed cached {old.name}")
        except Exception:
            pass


def _store_full_file(base: str, contents: bytes):
    """Called on upload — we already have every byte."""
    CACHE_DIR.mkdir(exist_ok=True)
    _cache_path(base).write_bytes(contents)
    _dl[base] = {"state": "ready", "done": len(contents), "total": len(contents)}
    _prune_cache()


def _download_full(name: str):
    base = name.rsplit("/", 1)[-1]
    if base not in _file_url:
        _file_info_cached(name)                  # discovers the working URL
    url = _file_url.get(base)
    if not url:
        _dl[base] = {"state": "failed", "error": "no download URL", "at": time.time()}
        return
    CACHE_DIR.mkdir(exist_ok=True)
    part = _cache_path(base).with_name(base + ".part")
    try:
        print(f"[RESIN LAYER] ⬇️ Downloading {base} for live layer view ...")
        with requests.get(url, stream=True, timeout=30) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length") or 0)
            _dl[base] = {"state": "downloading", "done": 0, "total": total}
            with open(part, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
                    _dl[base]["done"] += len(chunk)
        part.replace(_cache_path(base))
        _dl[base]["state"] = "ready"
        print(f"[RESIN LAYER] ✅ Cached {base} ({_dl[base]['done'] / 1e6:.1f} MB)")
        _prune_cache()
    except Exception as e:
        _dl[base] = {"state": "failed", "error": str(e), "at": time.time()}
        print(f"[RESIN LAYER] ❌ Download failed for {base}: {e}")
        try:
            part.unlink()
        except Exception:
            pass


def _ensure_file(name: str) -> dict:
    base = name.rsplit("/", 1)[-1]
    if _cache_path(base).exists():
        _dl.setdefault(base, {"state": "ready"})["state"] = "ready"
    elif _dl.get(base, {}).get("state") not in ("downloading",) and not (
            _dl.get(base, {}).get("state") == "failed" and time.time() - _dl[base].get("at", 0) < 60):
        _dl[base] = {"state": "downloading", "done": 0, "total": 0, "at": time.time()}
        threading.Thread(target=_download_full, args=(name,), daemon=True).start()
    return _dl[base]


def _get_index(base: str, info: dict):
    if base not in _layer_index:
        with open(_cache_path(base), "rb") as f:
            idx = index_layers(f, info["layer_def_addr"], info["layer_count"])
        if idx is None:
            print(f"[RESIN LAYER] ❌ Layer table in {base} didn't match the expected GOO layout")
        _layer_index[base] = idx
    return _layer_index[base]


@router.get("/resin/layer-status")
def resin_layer_status(filename: str = Query(...)):
    if not filename.lower().endswith(".goo"):
        return {"state": "unsupported"}
    d = _ensure_file(filename)
    return {k: d.get(k) for k in ("state", "done", "total", "error")}


@router.get("/resin/layer")
def resin_layer(filename: str = Query(...), layer: int = Query(1, ge=1)):
    """PNG of one layer (1-based), downsampled to ~720 px wide."""
    base = filename.rsplit("/", 1)[-1]
    if _ensure_file(filename)["state"] != "ready":
        return Response(status_code=202)
    info = _file_info_cached(filename)
    if not info:
        return Response(status_code=404)
    key = (base, layer)
    if key in _layer_png:
        _layer_png.move_to_end(key)
        return Response(content=_layer_png[key], media_type="image/png")
    idx = _get_index(base, info)
    if not idx:
        return Response(status_code=422)
    n = min(layer, len(idx)) - 1
    off, length, z = idx[n]
    with open(_cache_path(base), "rb") as f:
        f.seek(off)
        rle = f.read(length)
    t0 = time.perf_counter()
    aspect = (info["display_h_mm"] / info["display_w_mm"]) if info.get("display_w_mm") else None
    png, ok = render_layer_png(rle, info["res_x"], info["res_y"], aspect=aspect)
    if not ok:
        print(f"[RESIN LAYER] ⚠️ Layer {layer} of {base}: pixel count mismatch (decoder vs file)")
    record("resin", "api", "RENDER", "layer", "ok" if ok else "mismatch", time.perf_counter() - t0)
    _layer_png[key] = png
    while len(_layer_png) > 40:
        _layer_png.popitem(last=False)
    return Response(content=png, media_type="image/png", headers={"X-Layer-Z": str(z)})


def _px_mm2(info: dict) -> float:
    return (info["display_w_mm"] / info["res_x"]) * (info["display_h_mm"] / info["res_y"])


def _phase(layer: int, exposure: float, info: dict) -> str:
    if layer <= info.get("bottom_layers", 0):
        return "BOTTOM"
    if exposure > info.get("exposure_s", 0) + 0.01:
        return "TRANSITION"
    return "NORMAL"


@router.get("/resin/layer-meta")
def resin_layer_meta(filename: str = Query(...), layer: int = Query(1, ge=1)):
    """Per-layer values stored in the file + cured area of that layer."""
    base = filename.rsplit("/", 1)[-1]
    if _ensure_file(filename)["state"] != "ready":
        return Response(status_code=202)
    info = _file_info_cached(filename)
    idx = _get_index(base, info) if info else None
    if not idx:
        return Response(status_code=404)
    n = min(layer, len(idx))
    off, length, z = idx[n - 1]
    with open(_cache_path(base), "rb") as f:
        ls = read_layer_settings(f, off)
        prof = _area_profiles.get(base, {})
        if prof.get("state") == "ready":
            area = prof["areas"][n - 1]
        else:
            f.seek(off)
            px, _ = layer_cured_pixels(f.read(length), info["res_x"] * info["res_y"])
            area = round(px * _px_mm2(info), 1)
    return {
        "layer": n,
        "z_mm": round(ls["z"], 3),
        "exposure_s": round(ls["exposure"], 2),
        "wait_before_cure_s": round(ls["wait_before_cure"], 2),
        "pwm": ls["pwm"],
        "phase": _phase(n, ls["exposure"], info),
        "area_mm2": area,
    }


# Cured-area profile for every layer: computed once in the background, cached to disk
_area_profiles: dict = {}        # base -> {"state", "done", "total", "areas", "max_layer", "max_area"}


PROFILE_VER = "v2"


def _profile_path(base: str):
    return CACHE_DIR / f"{base}.profile.{PROFILE_VER}.json"


def _build_area_profile(name: str):
    """One pass over every layer: cured area, unsupported islands, peel-risk jumps,
    and planned time per layer (calibrated to the file's total print time)."""
    base = name.rsplit("/", 1)[-1]
    info = _file_info_cached(name)
    idx = _get_index(base, info) if info else None
    if not idx:
        _area_profiles[base] = {"state": "failed"}
        return
    prof = {"state": "computing", "done": 0, "total": len(idx), "areas": []}
    _area_profiles[base] = prof
    k, total = _px_mm2(info), info["res_x"] * info["res_y"]
    aspect = info["display_h_mm"] / info["display_w_mm"]
    t0 = time.time()
    areas, base_times, islands = [], [], []
    prev_grid = None
    with open(_cache_path(base), "rb") as f:
        for n, (off, length, _z) in enumerate(idx, 1):
            ls = read_layer_settings(f, off)
            base_times.append(ls["exposure"] + ls["wait_before_cure"] + ls["wait_after_cure"]
                              + ls["wait_after_lift"] + ls["light_off"])
            f.seek(off)
            rle = f.read(length)
            px, _ = layer_cured_pixels(rle, total)
            areas.append(round(px * k, 1))
            grid, w, h, _ok = decode_layer_grid(rle, info["res_x"], info["res_y"], aspect=aspect)
            if n > 1:
                found = find_unsupported_islands(grid, prev_grid, w, h)
                if found:
                    islands.append({"layer": n, "count": len(found), "pts": found[:20]})
            prev_grid = grid
            prof["done"] = n
    # planned time: per-layer settings + equal share of the remaining (motion) time
    overhead = max(0.0, (info.get("print_time_s", 0) - sum(base_times)) / len(idx)) if info.get("print_time_s") else 0.0
    cum, acc = [], 0.0
    for b in base_times:
        acc += b + overhead
        cum.append(round(acc, 1))
    # peel risk: sudden jumps in cured area after the bottom layers
    bottom = info.get("bottom_layers", 0)
    peel = [i + 1 for i in range(1, len(areas))
            if i + 1 > bottom and areas[i] - areas[i - 1] > 500 and areas[i] > 2.5 * max(areas[i - 1], 1)]
    m = max(range(len(areas)), key=lambda i: areas[i])
    result = {"areas": areas, "max_layer": m + 1, "max_area": areas[m], "islands": islands,
              "peel": peel, "cum_s": cum, "overhead_s": round(overhead, 2)}
    prof.update(state="ready", **result)
    try:
        _profile_path(base).write_text(json.dumps(result))
    except Exception:
        pass
    print(f"[RESIN LAYER] 📈 Profile for {base}: {len(idx)} layers in {time.time() - t0:.1f}s · "
          f"largest #{m + 1} ({areas[m]} mm²) · {len(islands)} island layer(s) · {len(peel)} peel jump(s)")


@router.get("/resin/area-profile")
def resin_area_profile(filename: str = Query(...)):
    base = filename.rsplit("/", 1)[-1]
    if _ensure_file(filename)["state"] != "ready":
        return {"state": "waiting"}
    prof = _area_profiles.get(base)
    if prof is None:
        cached = _profile_path(base)
        if cached.exists():
            try:
                prof = _area_profiles[base] = {"state": "ready", **json.loads(cached.read_text())}
            except Exception:
                prof = None
        if prof is None:
            _area_profiles[base] = {"state": "computing", "done": 0, "total": 0, "areas": []}
            threading.Thread(target=_build_area_profile, args=(filename,), daemon=True).start()
            prof = _area_profiles[base]
    if prof["state"] != "ready":
        return {k: prof.get(k) for k in ("state", "done", "total")}
    return {"state": "ready", **{k: prof.get(k) for k in
            ("areas", "max_layer", "max_area", "islands", "peel", "cum_s", "overhead_s")}}


@router.get("/resin/layer-times")
def resin_layer_times(last: int = 30):
    """Actual duration of recent layers in the running job: [[layer, seconds], ...]."""
    ts = sorted(_job["layer_ts"].items())
    out = [[l2, round(t2 - t1, 2)] for (l1, t1), (l2, t2) in zip(ts, ts[1:]) if l2 == l1 + 1]
    # the layer in progress: elapsed so far
    current = None
    if ts:
        current = {"layer": ts[-1][0], "elapsed_s": round(time.time() - ts[-1][1], 1)}
    return {"task_id": _job["task_id"], "file": _job["file"].rsplit("/", 1)[-1],
            "started": int(_job["started"]) if _job["started"] else None,
            "layers": out[-last:], "current": current}


@router.get("/resin/reports")
def resin_reports(limit: int = 50):
    if not REPORT_DIR.exists():
        return {"items": []}
    items = []
    for p in sorted(REPORT_DIR.glob("*.json"), reverse=True)[:limit]:
        try:
            items.append(json.loads(p.read_text()))
        except Exception:
            pass
    return {"items": items}


# ── Maintenance log ──
MAINT_FILE = _Path(__file__).resolve().parent.parent / "resin_maintenance.json"
MAINT_TYPES = {"film": "Release film replaced", "vat_clean": "Vat cleaned / resin filtered",
               "screen": "LCD screen replaced", "plate": "Build plate cleaned / leveled", "other": "Other"}


def _maint_load() -> dict:
    try:
        return json.loads(MAINT_FILE.read_text())
    except Exception:
        return {"entries": [], "vat_clean_every": 10}


@router.get("/resin/maintenance")
def resin_maintenance():
    m = _maint_load()
    entries = sorted(m["entries"], key=lambda e: e["t"], reverse=True)
    last = {k: next((e for e in entries if e["type"] == k), None) for k in MAINT_TYPES}
    # prints since last vat clean (from reports)
    since = last["vat_clean"]["t"] if last["vat_clean"] else 0
    prints_since = sum(1 for p in (REPORT_DIR.glob("*.json") if REPORT_DIR.exists() else [])
                       if int(p.name.split("_", 1)[0]) > since)
    film_used = state.get("machine_status", {}).get("release_film_count", 0)
    film_max = state.get("machine_status", {}).get("release_film_max", 60000) or 60000
    reminders = []
    if film_used >= 0.9 * film_max:
        reminders.append({"type": "film", "level": "due", "text": f"Release film at {film_used:,}/{film_max:,} lifts — replace"})
    elif film_used >= 0.75 * film_max:
        reminders.append({"type": "film", "level": "soon", "text": f"Release film at {film_used:,}/{film_max:,} lifts — replace soon"})
    if prints_since >= m.get("vat_clean_every", 10):
        reminders.append({"type": "vat_clean", "level": "due",
                          "text": f"{prints_since} prints since the vat was last cleaned"})
    return {"entries": entries[:100], "types": MAINT_TYPES, "vat_clean_every": m.get("vat_clean_every", 10),
            "prints_since_vat_clean": prints_since, "film_used": film_used, "film_max": film_max,
            "reminders": reminders}


@router.post("/resin/maintenance")
def resin_maintenance_add(kind: str = Query(...), note: str = "", vat_clean_every: int | None = None):
    m = _maint_load()
    if kind == "settings":
        if vat_clean_every:
            m["vat_clean_every"] = max(1, vat_clean_every)
    else:
        if kind not in MAINT_TYPES:
            raise HTTPException(400, "unknown type")
        m["entries"].append({"t": int(time.time()), "type": kind, "note": note[:300],
                             "film_count": state.get("machine_status", {}).get("release_film_count", 0)})
    MAINT_FILE.write_text(json.dumps(m, indent=2))
    print(f"[RESIN MAINT] 🔧 {MAINT_TYPES.get(kind, kind)} {note}")
    return resin_maintenance()


@router.delete("/resin/maintenance")
def resin_maintenance_delete(t: int = Query(...)):
    m = _maint_load()
    m["entries"] = [e for e in m["entries"] if e["t"] != t]
    MAINT_FILE.write_text(json.dumps(m, indent=2))
    return resin_maintenance()


@router.post("/resin/skip-preheat")
def resin_skip_preheat():
    """Cmd 133 — skip waiting for the tank to reach its target temperature."""
    return _ctrl(133, "🔥 Skip preheat")


# =============================
# VAT RESIN ENDPOINTS
# =============================
@router.get("/resin/vat")
def resin_vat():
    return {"ml": _vat.get("ml"), "low_ml": _vat.get("low_ml", 50), "log": _vat.get("log", [])[-20:][::-1]}


@router.post("/resin/vat")
def resin_vat_update(add_ml: float | None = None, set_ml: float | None = None, low_ml: float | None = None):
    """add_ml: poured in · set_ml: vat now holds this much · low_ml: warning threshold."""
    with _vat_lock:
        if set_ml is not None:
            _vat["ml"] = round(max(0.0, set_ml), 1)
            _vat_log("set", set_ml, "level set")
        if add_ml is not None:
            _vat["ml"] = round(max(0.0, (_vat.get("ml") or 0) + add_ml), 1)
            _vat_log("refill", add_ml, "refill")
        if low_ml is not None:
            _vat["low_ml"] = max(0.0, low_ml)
        _vat_save()
    print(f"[RESIN VAT] Vat ~{_vat.get('ml')} ml (low at {_vat.get('low_ml')} ml)")
    return resin_vat()


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
        slots_full = (not CAMERA_RELAY and frames == 0 and _video_slots["ack"] == 1 and _video_slots["used"] is not None
                      and _video_slots["max"] is not None and _video_slots["used"] >= _video_slots["max"])
        if slots_full:
            backoff = 60                                   # don't hammer a printer that's refusing
            print(f"[RESIN VIDEO] ❌ Camera refused: {_video_slots['used']}/{_video_slots['max']} stream slots taken. "
                  "Close other camera viewers (Elegoo app, slicer device view, another dashboard/backend) "
                  "or power-cycle the printer. Retrying in 60s")
        else:
            print(f"[RESIN VIDEO] Session ended after {frames} frames (exit {proc.returncode}) — retry in {backoff}s")
        time.sleep(backoff)
        if not slots_full:
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
        while not _shutting_down.is_set():          # Ctrl+C ends the stream so uvicorn can exit
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
