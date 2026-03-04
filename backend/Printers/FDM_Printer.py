from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse
import asyncio
import httpx
from typing import Set
import urllib.parse
import os
from dotenv import load_dotenv

load_dotenv()

PRINTER_IP = os.getenv("FDM_PRINTER_IP")
if not PRINTER_IP:
    raise ValueError("FDM_PRINTER_IP not set in .env file")
PRINTER_IP = "10.106.99.97"
BASE_URL = f"http://{PRINTER_IP}:7125"
PRINTER_STREAM_URL = f"{BASE_URL}/webcam/?action=stream"

POLL_INTERVAL = 5 

router = APIRouter()

connected_clients: Set[WebSocket] = set()
latest_status = {}
moonraker_connected = False


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
    dead = []
    for client in connected_clients:
        try:
            await client.send_json(data)
        except:
            dead.append(client)
    for d in dead:
        connected_clients.remove(d)


# =========================
# WEBSOCKET
# =========================
@router.websocket("/ws/printer")
async def printer_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    if latest_status:
        await websocket.send_json(latest_status)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
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

                moonraker_connected = True

                latest_status = {
                    "moonraker_connected": True,
                    "ui_state": ui_state,
                    "raw_status": status
                }

                print(f"✅ Stable | {ui_state}")

                await broadcast(latest_status)

            except Exception:
                moonraker_connected = False
                print("⚠️ Network glitch")

                await broadcast({
                    "moonraker_connected": False,
                    "ui_state": "Disconnected"
                })

            await asyncio.sleep(POLL_INTERVAL)


@router.on_event("startup")
async def startup_event():
    asyncio.create_task(poll_printer())


# =========================
# FILE LIST
# =========================
@router.get("/files")
async def list_files():
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            response = await client.get(f"{BASE_URL}/server/files/list")

        data = response.json()

        result = data.get("result", [])

        # Case 1: result is dict and has "files"
        if isinstance(result, dict):
            files_data = result.get("files", [])
        # Case 2: result itself is list
        elif isinstance(result, list):
            files_data = result
        else:
            files_data = []

        files = []
        for item in files_data:
            path = item.get("path", "")
            if path.endswith(".gcode"):
                # Remove "gcodes/" prefix for clean display
                filename = path.split("/")[-1]
                files.append(filename)

        return {"files": files}

    except Exception as e:
        print("File list error:", e)
        return {"files": []}

# =========================
# UPLOAD
# =========================
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
        safe_filename = urllib.parse.unquote(filename)

        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            response = await client.post(
                f"{BASE_URL}/printer/print/start",
                json={"filename": safe_filename}
            )

        print("Start response:", response.text)

        return {
            "status": response.is_success,
            "response": response.text
        }

    except Exception as e:
        print("Start error:", e)
        return {"status": False, "error": str(e)}


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
async def video_feed():
    async def generate():
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", PRINTER_STREAM_URL) as r:
                async for chunk in r.aiter_bytes():
                    yield chunk

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )