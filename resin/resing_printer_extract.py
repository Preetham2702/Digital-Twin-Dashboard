"""
Elegoo Saturn 4 Ultra — Live Data Logger (JSON)
Connects via SDCP WebSocket and saves all values to JSON in real time.

Output: printer_log_YYYYMMDD_HHMMSS.json
Format: list of snapshots, one per update

Usage:
    python3 logger.py              # logs until Ctrl-C
    python3 logger.py --duration 60  # logs for 60 seconds
"""

import socket
import json
import uuid
import time
import sys
import os
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────────
PRINTER_IP = "10.106.88.174"
JSON_FILE  = f"test_data.json"

PRINT_STATUS_MAP = {
    0:  "IDLE",
    1:  "PRINTING",
    2:  "FILE_TRANSFER",
    4:  "EXPOSURE",
    8:  "PAUSED",
    16: "STOPPING",
    17: "FINISHED",
}

# ── State ─────────────────────────────────────────────────────────────────────
state = {}
start_time = time.time()
layer_height_mm = None
log_entries = []


# ── Get MainboardID via UDP ────────────────────────────────────────────────────
def get_mainboard_id():
    print(f"[*] Discovering printer at {PRINTER_IP} ...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(5)
    try:
        sock.sendto(b'M99999', (PRINTER_IP, 3000))
        data, _ = sock.recvfrom(4096)
        info = json.loads(data)
        mid = info["Data"]["MainboardID"]
        print(f"[+] {info['Data']['MachineName']}  |  ID: {mid}  |  FW: {info['Data']['FirmwareVersion']}")
        return mid
    except Exception as e:
        print(f"[!] Discovery failed: {e}")
        sys.exit(1)
    finally:
        sock.close()


# ── Try to get layer height from .goo file header ─────────────────────────────
def try_get_layer_height(filename):
    global layer_height_mm
    if not filename or layer_height_mm is not None:
        return
    try:
        import urllib.request, struct
        name = filename.split("/")[-1]
        url  = f"http://{PRINTER_IP}:3030/media/mmcblk0p3/{name}"
        req  = urllib.request.Request(url, headers={"Range": "bytes=0-4096"})
        data = urllib.request.urlopen(req, timeout=3).read()
        for offset in [72, 76, 80, 84, 88, 92, 96, 100]:
            if offset + 4 <= len(data):
                val = struct.unpack_from("<f", data, offset)[0]
                if 0.01 <= val <= 0.2:
                    layer_height_mm = round(val, 4)
                    print(f"[+] Layer height: {layer_height_mm}mm")
                    return
    except Exception:
        pass


# ── Parse incoming WebSocket message into state dict ──────────────────────────
def parse_message(raw):
    global state
    try:
        data = json.loads(raw)
    except Exception:
        return False

    updated = False

    # ── Status message ─────────────────────────────────────────────
    if "Status" in data:
        s  = data["Status"]
        pi = s.get("PrintInfo", {})
        dev = s.get("DevicesStatus", {})

        cs = s.get("CurrentStatus", [0])
        cs_val = cs[0] if isinstance(cs, list) else cs

        cur = pi.get("CurrentTicks", 0)
        tot = pi.get("TotalTicks", 0)
        cur_layer = pi.get("CurrentLayer", 0)

        state["timestamp"]          = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state["elapsed_seconds"]    = round(time.time() - start_time, 1)

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

    # Attributes message ignored — not needed

    return updated


# ── Print live summary ─────────────────────────────────────────────────────────
def print_summary():
    p  = state.get("print", {})
    t  = state.get("temperature", {})
    ms = state.get("machine_status", {})
    remain = p.get("remaining_time_min", 0)
    h, m   = divmod(int(remain), 60)
    remain_str = f"{h}h {m}m" if h > 0 else f"{m}m"

    print(f"\n  ┌─── {state.get('timestamp', '—')} ──────────────────────────────────")
    print(f"  │ File      : {p.get('filename', '—')}")
    print(f"  │ Status    : {p.get('status', '—')}")
    print(f"  │ Layer     : {p.get('current_layer', '—')} / {p.get('total_layers', '—')}")
    print(f"  │ Progress  : {p.get('progress_percent', 0)}%")
    print(f"  │ Remaining : {remain_str}")
    if p.get("z_position_mm"):
        print(f"  │ Z Position: {p.get('z_position_mm')} mm")
    print(f"  │ UV Temp   : {t.get('uvled_c', '—')} °C")
    print(f"  │ Tank Temp : {t.get('tank_c', '—')} °C  (target {t.get('tank_target_c', '—')} °C)")
    print(f"  │ Heater    : {'ON' if ms.get('heat_on') else 'OFF'}")
    print(f"  │ Film used : {ms.get('release_film_count', '—')} / {ms.get('release_film_max', '—')}")
    print(f"  │ Errors    : {p.get('error_number', 0)}")

    print(f"  └────────────────────────────────────────────────────────────────")


# ── Save JSON file ─────────────────────────────────────────────────────────────
def save_json():
    with open(JSON_FILE, "w") as f:
        json.dump(log_entries, f, indent=2)


# ── Main ──────────────────────────────────────────────────────────────────────
def run(duration=None):
    try:
        import websocket
    except ImportError:
        print("[!] Run: pip3 install websocket-client")
        sys.exit(1)

    mainboard_id = get_mainboard_id()
    print(f"[+] Logging to: {JSON_FILE}\n")

    ws_url = f"ws://{PRINTER_IP}:3030/websocket"

    def make_cmd(cmd_id):
        return json.dumps({
            "Id": uuid.uuid4().hex,
            "Data": {
                "Cmd": cmd_id,
                "Data": {},
                "From": 0,
                "MainboardID": mainboard_id,
                "RequestID": uuid.uuid4().hex,
                "TimeStamp": int(time.time() * 1000)
            },
            "Topic": f"sdcp/request/{mainboard_id}"
        })

    try:
        ws = websocket.create_connection(ws_url, timeout=10)
        print("[+] Connected! Logging started — Ctrl-C to stop\n")

        for cmd in [0, 1]:
            ws.send(make_cmd(cmd))
            time.sleep(0.2)

        ws.settimeout(3)
        deadline  = time.time() + duration if duration else float("inf")
        last_save = 0

        while time.time() < deadline:
            try:
                raw = ws.recv()
                if parse_message(raw):
                    print_summary()
                    # Append snapshot and save
                    if time.time() - last_save >= 1.0:
                        log_entries.append(dict(state))
                        save_json()
                        last_save = time.time()

            except websocket.WebSocketTimeoutException:
                ws.send(make_cmd(0))
            except KeyboardInterrupt:
                raise
            except Exception as e:
                print(f"[!] Error: {e}")
                break

    except KeyboardInterrupt:
        print(f"\n[*] Stopped.")
    finally:
        save_json()
        try:
            ws.close()
        except Exception:
            pass

    print(f"\n[+] Saved {len(log_entries)} entries to: {JSON_FILE}")


# ── CLI ────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    duration = None
    if "--duration" in sys.argv:
        idx = sys.argv.index("--duration")
        duration = int(sys.argv[idx + 1])
        print(f"[*] Will log for {duration} seconds")

    run(duration=duration)