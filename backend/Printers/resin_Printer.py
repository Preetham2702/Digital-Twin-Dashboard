from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import RedirectResponse
import asyncio
import json
import os
from typing import Set
from dotenv import load_dotenv
import websockets
import requests
import socket
import httpx

load_dotenv()

router = APIRouter()


PRINTER_IP = os.getenv("RESIN_PRINTER_IP")
WS_URL = f"ws://{PRINTER_IP}:3030"
CAMERA_URL = os.getenv("RESIN_CAMERA_URL")

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


# async def broadcast(data):
#     dead = []
#     for ws in clients:
#         try:
#             await ws.send_json(data)
#         except:
#             dead.append(ws)
#     for d in dead:
#         clients.remove(d)

async def broadcast(data):
    dead = []
    for client in clients:
        try:
            await client.send_json(data)
        except:
            dead.append(client)
    for d in dead:
        clients.remove(d)

# =============================
# FRONTEND WEBSOCKET
# =============================
@router.websocket("/ws/resin")
async def resin_ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)

    print("🟢 UI Connected to Resin")

    await websocket.send_json(state)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        clients.remove(websocket)
        print("🔴 UI Disconnected")

# async def poll_resin():
#     while True:
#         try:
#             res = requests.get(f"http://{PRINTER_IP}:3030/api/job/status", timeout=2)
#             data = res.json()

#             payload = {
#                 "connected": True,
#                 "status": data.get("status"),
#                 "layer": data.get("layer"),
#                 "progress": data.get("progress"),
#             }

#             await broadcast(payload)

#         except:
#             await broadcast({"connected": False})

#         await asyncio.sleep(1)

async def listen_to_resin():
    global state

    async with httpx.AsyncClient() as client:
        while True:
            try:
                res = await client.get(f"http://{PRINTER_IP}:3030", timeout=2.0)

                # 🔥 Only mark connected if response is valid
                if res.status_code == 200 and len(res.text) > 0:
                    state["printer_connected"] = True
                else:
                    state["printer_connected"] = False

                # ❗ No real API → keep previous values
                print("🟢 Resin Reachable")

            except Exception as e:
                state["printer_connected"] = False
                print("🔴 Resin Disconnected:", e)

            await broadcast(state)
            await asyncio.sleep(1)


@router.on_event("startup")
async def startup_event():
    asyncio.create_task(listen_to_resin())

@router.post("/start")
async def start():
    state["status"] = "Printing"
    print("🟢 Print Started")
    return {"status": True}

@router.post("/pause")
async def pause():
    state["status"] = "Paused"
    print("⏸ Print Paused")
    return {"status": True}

@router.post("/stop")
async def stop():
    state["status"] = "Stopped"
    state["layer"] = 0
    print("🛑 Print Stopped")
    return {"status": True}

@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    contents = await file.read()

    os.makedirs("uploads", exist_ok=True)

    with open(f"uploads/{file.filename}", "wb") as f:
        f.write(contents)

    state["total_layers"] = 2000  # TEMP

    print(f"📦 File uploaded | Layers: {state['total_layers']}")

    return {
        "filename": file.filename,
        "total_layers": state["total_layers"]
    }


@router.get("/video_feed")
def video_feed():
    return RedirectResponse(CAMERA_URL)