from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse
import asyncio
import websockets
import json
import requests
from typing import Set


import os
from dotenv import load_dotenv

load_dotenv()

PRINTER_IP = os.getenv("FDM_PRINTER_IP")
if not PRINTER_IP:
    raise ValueError("FDM_PRINTER_IP not set in .env file")

BASE_URL = f"http://{PRINTER_IP}:7125"
MOONRAKER_WS = f"ws://{PRINTER_IP}:7125/websocket"
PRINTER_STREAM_URL = f"{BASE_URL}/webcam/?action=stream"

router = APIRouter()

connected_clients: Set[WebSocket] = set()
latest_status = {}
moonraker_connected = False


# ====================================
# STATE MAPPING
# =====================================
def map_state(raw_state: str) -> str:
    mapping = {
        "printing": "Printing",
        "paused": "Paused",
        "canceled": "Stopped",
        "complete": "Completed",
        "standby": "Idle",
        "idle": "Idle",
        "error": "Error"
    }
    return mapping.get(raw_state, "Idle")


# =====================================
# BROADCAST TO FRONTEND
# =====================================
async def broadcast(data):
    dead = []
    for client in connected_clients:
        try:
            await client.send_json(data)
        except:
            dead.append(client)
    for d in dead:
        connected_clients.remove(d)


# =====================================
# FRONTEND WEBSOCKET
# =====================================
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


# =====================================
# MOONRAKER LISTENER
# =====================================
async def listen_to_printer():
    global latest_status, moonraker_connected

    while True:
        try:
            async with websockets.connect(MOONRAKER_WS) as ws:
                moonraker_connected = True
                print("Moonraker Connected")

                subscribe = {
                    "jsonrpc": "2.0",
                    "method": "printer.objects.subscribe",
                    "params": {
                        "objects": {
                            "extruder": None,
                            "heater_bed": None,
                            "toolhead": None,
                            "print_stats": None,
                            "virtual_sdcard": None,
                            "motion_report": None,
                            "gcode_move": None
                        }
                    },
                    "id": 1
                }

                await ws.send(json.dumps(subscribe))

                while True:
                    msg = await ws.recv()
                    data = json.loads(msg)
                    status = data.get("params", {}).get("status")

                    if status:
                        raw_state = status.get("print_stats", {}).get("state", "idle")
                        ui_state = map_state(raw_state)

                        latest_status = {
                            "moonraker_connected": moonraker_connected,
                            "ui_state": ui_state,
                            "raw_status": status
                        }

                        await broadcast(latest_status)

        except Exception as e:
            moonraker_connected = False
            print("Moonraker Disconnected", e)

            await broadcast({
                "moonraker_connected": False,
                "ui_state": "Disconnected"
            })

            await asyncio.sleep(5)


@router.on_event("startup")
async def startup_event():
    asyncio.create_task(listen_to_printer())


# =====================================
# VIDEO STREAM
# =====================================
@router.get("/video_feed")
def video_feed():
    def generate():
        with requests.get(PRINTER_STREAM_URL, stream=True) as r:
            for chunk in r.iter_content(chunk_size=1024):
                if chunk:
                    yield chunk

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# =====================================
# FILE UPLOAD
# =====================================
@router.post("/upload")
async def upload_gcode(file: UploadFile = File(...)):
    files = {
        "file": (file.filename, await file.read(), "application/octet-stream")
    }

    response = requests.post(
        f"{BASE_URL}/server/files/upload",
        files=files,
        data={"root": "gcodes"},
    )

    return {"status": response.ok}


# =====================================
# START PRINT
# =====================================
@router.post("/start/{filename}")
async def start_print(filename: str):
    response = requests.post(
        f"{BASE_URL}/printer/print/start",
        json={"filename": filename}
    )
    return {"status": response.ok}


# =====================================
# STOP PRINT
# =====================================
@router.post("/stop")
async def stop_print():
    response = requests.post(f"{BASE_URL}/printer/print/cancel")
    return {"status": response.ok}