from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File, Body
from fastapi.responses import StreamingResponse
import asyncio
import os
from typing import Set
from dotenv import load_dotenv
import requests
import socket

load_dotenv()

router = APIRouter()

PRINTER_IP = os.getenv("RESIN_PRINTER_IP")

clients: Set[WebSocket] = set()

state = {
    "status": "Idle",
    "layer": 0,
    "total_layers": 0,
    "progress": 0,
    "z_height": 0,
    "layer_time": 0,
    "printer_connected": False
}

# =============================
# BROADCAST
# =============================
async def broadcast():
    dead = []
    for client in clients:
        try:
            await client.send_json(state)
        except:
            dead.append(client)
    for d in dead:
        clients.remove(d)


# =============================
# WEBSOCKET
# =============================
@router.websocket("/ws/resin")
async def resin_ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)

    await websocket.send_json(state)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        clients.remove(websocket)


# =============================
# CONNECTION CHECK
# =============================
async def monitor_connection():
    while True:
        try:
            sock = socket.socket()
            sock.settimeout(1)
            sock.connect((PRINTER_IP, 3030))
            sock.close()

            state["printer_connected"] = True

        except:
            state["printer_connected"] = False

        await broadcast()
        await asyncio.sleep(1)


@router.on_event("startup")
async def startup_event():
    asyncio.create_task(monitor_connection())


# =============================
# START / PAUSE / STOP (UI ONLY)
# =============================
@router.post("/start")
async def start(dummy: dict = Body(default={})):
    state["status"] = "Printing"
    return {"status": True}


@router.post("/pause")
async def pause(dummy: dict = Body(default={})):
    state["status"] = "Paused"
    return {"status": True}


@router.post("/stop")
async def stop(dummy: dict = Body(default={})):
    state["status"] = "Stopped"
    state["progress"] = 0
    return {"status": True}


# =============================
# FILE UPLOAD (REAL PRINTER)
# =============================
@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    contents = await file.read()

    files = {
        "file": (file.filename, contents, "application/octet-stream")
    }

    try:
        res = requests.post(
            f"http://{PRINTER_IP}:3030/uploadFile/upload",
            files=files,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=20
        )

        print("UPLOAD RESPONSE:", res.text)

        if res.ok:
            state["status"] = "File Uploaded"
            state["total_layers"] = 2000  # temp for UI

        return {"success": res.ok}

    except Exception as e:
        print("UPLOAD ERROR:", e)
        return {"success": False}


# =============================
# IMAGE PREVIEW (WORKING)
# =============================
@router.get("/preview")
def preview():
    # 🔥 Replace this with YOUR actual BMP file from /media/
    url = f"http://{PRINTER_IP}:3030/media/mmcblk0p1/history_image/preview.bmp"

    try:
        res = requests.get(url)
        return StreamingResponse(iter([res.content]), media_type="image/bmp")
    except:
        return {"error": "Preview not available"}