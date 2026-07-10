from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse
import asyncio
import httpx
from typing import Set
import urllib.parse
import os
from dotenv import load_dotenv
import urllib.parse
from services.bed_detector import (
    save_empty_bed,
    check_bed_status
)


load_dotenv()

PRINTER_IP = os.getenv("FDM_PRINTER_IP")
if not PRINTER_IP:
    raise ValueError("FDM_PRINTER_IP not set in .env file")
BASE_URL = f"http://{PRINTER_IP}:7125"
PRINTER_STREAM_URL = f"http://{PRINTER_IP}:8080/?action=stream"

POLL_INTERVAL = 1

router = APIRouter()
connected_clients: Set[WebSocket] = set()
latest_status = {}
moonraker_connected = False

last_state = "Idle"
bed_monitor_running = False
idle_bed_alerted = False   # tracks whether the idle watcher has an active alert

# =========================
# BED MONITOR TUNING
# =========================
BED_SETTLE_SECONDS = 10       # wait after completion for the toolhead to park / bed to settle
BED_CHECK_INTERVAL = 10       # seconds between camera checks (post-completion)
BED_CONFIRM_CHECKS = 2        # consecutive "present" checks before alerting (~20s)
IDLE_CHECK_INTERVAL = 5 * 60  # while idle, re-check the bed every 5 minutes

# =========================
# STATE MAPPING
# =========================
def map_state(raw_state: str) -> str:
    mapping = {
        "printing": "Printing",
        "paused": "Paused",
        "canceled": "Stopped",
        "complete": "Completed",
        "standby": "Idle",
        "idle": "Idle",
        "ready": "Idle",
        "error": "Error"
    }
    return mapping.get(raw_state, "Idle")


# =========================
# BROADCAST
# =========================
async def broadcast(data):
    if not connected_clients:
        return

    async def _send(ws):
        try:
            await asyncio.wait_for(ws.send_json(data), timeout=2)
            return None
        except Exception:
            return ws  # mark as dead

    # send to everyone at once — a stuck socket can't block the others
    results = await asyncio.gather(*[_send(ws) for ws in list(connected_clients)])
    for ws in results:
        if ws is not None:
            connected_clients.discard(ws)

# =========================
# WEBSOCKET
# =========================
@router.websocket("/ws/printer")
async def printer_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    print("✅ FDM connected")

    try:
        # optional initial send
        if latest_status:
            try:
                await websocket.send_json(latest_status)
            except:
                pass

        while True:
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                break   

    except Exception as e:
        print("WS error:", e)

    finally:
        print("❌ FDM client disconnected")
        if websocket in connected_clients:
            connected_clients.remove(websocket)

# =========================
# POLLING LOOP
# =========================
async def poll_printer():
    global latest_status, moonraker_connected

    await asyncio.sleep(5)

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        while True:
            try:
                response = await client.get(
                    f"{BASE_URL}/printer/objects/query",
                    params={
                        "extruder": "",
                        "heater_bed": "",
                        "toolhead": "",
                        "print_stats": "",
                        "virtual_sdcard": "",
                        "gcode_move": "",
                        "motion_report": ""
                    }
                )

                status = response.json()["result"]["status"]

                raw_state = status.get("print_stats", {}).get("state", "idle")
                ui_state = map_state(raw_state)
                global last_state
                global bed_monitor_running
                global idle_bed_alerted

                moonraker_connected = True
                if (
                    last_state == "Printing"
                    and ui_state in ["Completed", "Stopped"]
                    and not bed_monitor_running
                ):
                    asyncio.create_task(
                        monitor_bed_until_empty()
                    )

                if ui_state == "Printing":
                    bed_monitor_running = False
                    idle_bed_alerted = False   # new print clears any stale idle alert

                last_state = ui_state

                latest_status = {
                    "moonraker_connected": True,
                    "ui_state": ui_state,
                    "raw_status": status,
                    "file_position": status.get("virtual_sdcard", {}).get("file_position", 0)
                }

                print(f"✅ Stable(FDM) | {ui_state}")

                await broadcast(latest_status)

            except Exception:
                moonraker_connected = False
                print("⚠️ Network glitch")

                await broadcast({
                    **latest_status,
                    "moonraker_connected": False,
                    "ui_state": "Disconnected"
                })

            await asyncio.sleep(POLL_INTERVAL)


@router.on_event("startup")
async def startup_event():
    asyncio.create_task(poll_printer())
    asyncio.create_task(idle_bed_check_loop())


# =========================
# FILE LIST
# =========================
@router.get("/files")
async def list_files():
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{BASE_URL}/server/files/list",
                params={"root": "gcodes"}
            )

        data = response.json()



        # 🔥 HANDLE FORMAT SAFELY
        if isinstance(data, list):
            files_data = data

        elif isinstance(data, dict):
            if "result" in data:
                if isinstance(data["result"], list):
                    files_data = data["result"]
                else:
                    files_data = data["result"].get("files", [])
            else:
                files_data = data.get("files", [])
        else:
            files_data = []

        files = []
        for item in files_data:
            if isinstance(item, dict):
                path = item.get("path", "")
                if path.endswith(".gcode") or path.endswith(".g"):
                    files.append(path)

        return {"files": files}

    except Exception as e:
        print("File list error:", e)
        return {"files": []}
        

@router.post("/upload")
async def upload_gcode(file: UploadFile = File(...)):
    content = await file.read()

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        response = await client.post(
            f"{BASE_URL}/server/files/upload",
            files={"file": (file.filename, content)},
            data={"root": "gcodes"},
        )

    print("Upload response:", response.text)

    return {
        "status": response.is_success,
        "filename": file.filename
    }


# =========================
# START PRINT
# =========================
@router.post("/start")
async def start_print(filename: str):
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:

            # 🔥 GET CURRENT STATE
            status_res = await client.get(
                f"{BASE_URL}/printer/objects/query",
                params={"print_stats": ""}
            )

            status = status_res.json()["result"]["status"]["print_stats"]["state"]

            # 🔥 CASE 1: RESUME IF PAUSED
            if status == "paused":
                await client.post(f"{BASE_URL}/printer/print/resume")
                return {"status": "resumed"}

            # 🔥 CASE 2: START NEW PRINT
            await client.post(
                f"{BASE_URL}/printer/print/start",
                json={"filename": filename}
            )

            return {"status": "started"}

    except Exception as e:
        return {"error": str(e)}


# =========================
# STOP PRINT
# =========================
@router.post("/stop")
async def stop_print():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{BASE_URL}/printer/print/cancel"
            )
        return {"status": True}
    except Exception as e:
        print("Stop error:", e)
        return {"status": False}

# =========================
# PAUSE PRINT
# =========================
@router.post("/pause")
async def pause_print():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{BASE_URL}/printer/gcode/script",
                json={"script": "PAUSE"}
            )

        return {"status": True}

    except Exception as e:
        print("Pause error:", e)
        return {"status": False}

# =========================
# VIDEO STREAM
# =========================
@router.get("/video_feed")
def video_feed():
    def generate():
        try:
            with requests.get(PRINTER_STREAM_URL, stream=True) as r:
                for chunk in r.raw:
                    yield chunk
        except Exception as e:
            print("Stream error:", e)

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=--frame"
    )

@router.get("/gcode")
async def get_gcode(file: str):
    try:
        import urllib.parse

        # 🔥 CLEAN FILE
        clean_file = file.replace(".cache/", "").strip()

        # 🔥 ENCODE
        safe_file = urllib.parse.quote(clean_file)

        print("REQUESTING GCODE:", safe_file)

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{BASE_URL}/server/files/gcodes/{safe_file}"
            )

        if not response.is_success:
            print("Moonraker error:", response.text)
            return ""

        return response.text

    except Exception as e:
        print("GCODE fetch error:", e)
        return ""
    
# =========================
# GET CURRENT PRINT STATUS (NEW 🔥)
# =========================
@router.get("/printer/status")
async def get_print_status():
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{BASE_URL}/printer/objects/query",
                params={
                    "print_stats": "",
                    "virtual_sdcard": ""
                }
            )

        data = response.json()["result"]["status"]

        print_stats = data.get("print_stats", {})
        vsd = data.get("virtual_sdcard", {})

        raw_state = print_stats.get("state", "idle")
        ui_state = map_state(raw_state)

        filename = print_stats.get("filename", "")

        is_printing = raw_state in ["printing", "paused"]

        return {
            "is_printing": is_printing,
            "state": ui_state,
            "filename": filename,
            "progress": (vsd.get("progress", 0) * 100),
            "file_position": vsd.get("file_position", 0)
        }

    except Exception as e:
        print("Status API error:", e)
        return {
            "is_printing": False,
            "state": "Disconnected",
            "filename": ""
        }

# =========================
# BED DETECTION ENDPOINTS
# =========================
# check_bed_status() / save_empty_bed() do blocking network + OpenCV work, so
# run them off the event loop with asyncio.to_thread — a slow camera grab must
# never stall the broadcast loop.

@router.post("/capture-empty-bed")
async def capture_empty_bed():
    return await asyncio.to_thread(save_empty_bed)


@router.get("/bed-status")
async def bed_status():
    return await asyncio.to_thread(check_bed_status)


# Calibration helper: hit this empty-vs-loaded to read area_frac and tune
# BED_MIN_AREA_FRAC. Same as /bed-status but named clearly for tuning.
@router.get("/bed-debug")
async def bed_debug():
    return await asyncio.to_thread(check_bed_status)


# =========================
# BED MONITOR (runs after a print completes)
# =========================
async def monitor_bed_until_empty():
    global bed_monitor_running
    bed_monitor_running = True

    # 1) let the machine settle after the print ends (toolhead parks, bed stops)
    await asyncio.sleep(BED_SETTLE_SECONDS)

    present_streak = 0
    alerted = False

    while bed_monitor_running:
        try:
            # run OpenCV off the event loop so it can't block broadcasts
            result = await asyncio.to_thread(check_bed_status)

            if not result.get("success"):
                # camera / reference problem — wait and retry, don't alert
                await asyncio.sleep(BED_CHECK_INTERVAL)
                continue

            if result["print_present"]:
                present_streak += 1

                # 3) confirmed present across ~20s -> alert ONCE
                if present_streak >= BED_CONFIRM_CHECKS and not alerted:
                    await broadcast({
                        "event": "bed_status",
                        "bed_status": "Print Not Removed",
                        "area_frac": result.get("area_frac", 0),
                        "changed_pixels": result.get("changed_pixels", 0),
                    })
                    alerted = True
            else:
                # bed is clear — announce only if we had alerted, then stop
                if alerted:
                    await broadcast({
                        "event": "bed_status",
                        "bed_status": "Bed Empty"
                    })
                bed_monitor_running = False
                break

        except Exception as e:
            print("Bed monitor error:", e)

        await asyncio.sleep(BED_CHECK_INTERVAL)


# =========================
# IDLE BED WATCHER (runs every 5 min while the machine is idle)
# =========================
# Catches a part left on the bed even when we never saw the print finish —
# e.g. the backend was restarted, or a part was placed manually. Stays out of
# the way while a print is running or while the post-completion monitor is active.
async def idle_bed_check_loop():
    global idle_bed_alerted

    await asyncio.sleep(30)  # let startup settle before the first check

    while True:
        await asyncio.sleep(IDLE_CHECK_INTERVAL)

        # Skip if a print is running, or the tight post-completion monitor owns
        # the bed right now (avoids double-broadcasting).
        if bed_monitor_running:
            continue
        if last_state not in ("Idle", "Completed", "Stopped"):
            continue

        try:
            # debounce: two checks ~10s apart must agree before we act
            r1 = await asyncio.to_thread(check_bed_status)
            if not r1.get("success"):
                continue

            await asyncio.sleep(10)
            r2 = await asyncio.to_thread(check_bed_status)
            if not r2.get("success"):
                continue

            present = r1["print_present"] and r2["print_present"]

            if present and not idle_bed_alerted:
                await broadcast({
                    "event": "bed_status",
                    "bed_status": "Print Not Removed",
                    "area_frac": r2.get("area_frac", 0),
                    "changed_pixels": r2.get("changed_pixels", 0),
                })
                idle_bed_alerted = True

            elif not present and idle_bed_alerted:
                await broadcast({
                    "event": "bed_status",
                    "bed_status": "Bed Empty"
                })
                idle_bed_alerted = False

        except Exception as e:
            print("Idle bed check error:", e)