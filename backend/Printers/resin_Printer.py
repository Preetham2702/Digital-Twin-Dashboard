from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse
import asyncio
import time
import socket
from typing import Set
import os
from dotenv import load_dotenv

router = APIRouter()

# =============================
# CONFIG
# =============================
PRINTER_IP = os.getenv("RESIN_PRINTER_IP")
PRINTER_PORT = 80

clients: Set[WebSocket] = set()

# =============================
# STATE
# =============================
status = "Idle"
layer = 0
total_layers = 0
z_height = 0
layer_time = 0
progress = 0

printer_connected = False

# parameters
layer_height = 0
exposure_time = 0
bottom_exposure = 0
bottom_layers = 0
lift_time = 0
retract_time = 0


# =============================
# PRINTER CHECK
# =============================
def check_printer():
    global printer_connected
    try:
        sock = socket.create_connection((PRINTER_IP, PRINTER_PORT), timeout=2)
        sock.close()
        printer_connected = True
    except:
        printer_connected = False


# =============================
# STATE BUILDER
# =============================
def get_state():
    return {
        "status": status,
        "layer": layer,
        "total_layers": total_layers,
        "progress": progress,
        "z_height": z_height,
        "layer_time": layer_time,
        "printer_connected": printer_connected
    }


# =============================
# BROADCAST
# =============================
async def broadcast(data):
    dead = []
    for ws in clients:
        try:
            await ws.send_json(data)
        except:
            dead.append(ws)
    for d in dead:
        clients.remove(d)


# =============================
# WEBSOCKET
# =============================
@router.websocket("/ws/resin")
async def resin_ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)

    await websocket.send_json(get_state())

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        clients.remove(websocket)


# =============================
# PRINT LOOP (REAL TIME)
# =============================
async def run_print():
    global layer, progress, z_height, layer_time, status

    while True:
        check_printer()

        if status == "Printing" and total_layers > 0:

            if layer >= total_layers:
                status = "Completed"
                await broadcast(get_state())
                continue

            layer += 1

            # exposure logic
            if layer <= bottom_layers:
                exposure = bottom_exposure
            else:
                exposure = exposure_time

            layer_time = exposure + lift_time + retract_time

            await asyncio.sleep(layer_time)

            z_height = round(layer * layer_height, 3)
            progress = round((layer / total_layers) * 100, 2)

            await broadcast(get_state())

        else:
            await broadcast(get_state())
            await asyncio.sleep(1)


# =============================
# CONTROL
# =============================
@router.post("/start")
async def start():
    global status
    if not printer_connected:
        return {"status": False, "error": "Printer not connected"}
    status = "Printing"
    return {"status": True}


@router.post("/pause")
async def pause():
    global status
    status = "Paused"
    return {"status": True}


@router.post("/stop")
async def stop():
    global status, layer
    status = "Stopped"
    layer = 0
    return {"status": True}


# =============================
# FILE UPLOAD
# =============================
@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    global total_layers

    contents = await file.read()

    with open(f"uploads/{file.filename}", "wb") as f:
        f.write(contents)

    total_layers = 2000  # 🔥 replace later with parser

    return {
        "filename": file.filename,
        "total_layers": total_layers
    }


# =============================
# CAMERA
# =============================
@router.get("/video_feed")
def video_feed():
    def fake_stream():
        while True:
            yield (b"--frame\r\n"
                   b"Content-Type: image/jpeg\r\n\r\n" +
                   b"\xff\xd8\xff\xe0" +
                   b"\x00" * 1024 +
                   b"\r\n")
            time.sleep(0.1)

    return StreamingResponse(
        fake_stream(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )