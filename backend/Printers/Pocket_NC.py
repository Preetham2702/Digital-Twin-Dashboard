from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import socket
import json
from typing import Set

router = APIRouter()

connected_clients: Set[WebSocket] = set()

# 👉 Use hostname if possible (better than changing IP)
POCKETNC_IP = "169.254.222.72"   # or "pocketnc.local"
PORT = 5000


# =========================
# FRONTEND WEBSOCKET
# =========================
@router.websocket("/ws/pocketnc")
async def pocketnc_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    try:
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        connected_clients.remove(websocket)


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
# SOCKET STREAM (NON-BLOCKING)
# =========================
async def stream_loop():
    while True:
        try:
            print("🔌 Connecting to PocketNC socket...")

            # create socket (non-blocking via thread)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

            # connect without blocking event loop
            await asyncio.to_thread(sock.connect, (POCKETNC_IP, PORT))

            print("✅ Connected to PocketNC stream")

            # 🔥 IMMEDIATE CONNECTION SIGNAL (YOUR REQUIREMENT)
            await broadcast({
                "connected": True,
                "raw_status": {}
            })

            buffer = ""

            while True:
                # read socket safely (non-blocking)
                chunk = await asyncio.to_thread(sock.recv, 1024)

                if not chunk:
                    raise Exception("Socket disconnected")

                buffer += chunk.decode()

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)

                    raw = json.loads(line.strip())

                    # format exactly for your frontend
                    data = {
                        "connected": True,
                        "raw_status": {
                            "spindle_speed": raw.get("rpm", 0),
                            "feed_rate": raw.get("feed", 0),
                            "toolhead": {
                                "position": [
                                    raw.get("x", 0),
                                    raw.get("y", 0),
                                    raw.get("z", 0),
                                    raw.get("a", 0),
                                    raw.get("b", 0),
                                ]
                            }
                        }
                    }
                
                    await broadcast(data)

        except Exception as e:
            print("❌ Socket error:", e)

            # 🔥 SEND DISCONNECTED STATUS
            await broadcast({
                "connected": False,
                "raw_status": {}
            })

            await asyncio.sleep(2)


# =========================
# START BACKGROUND STREAM
# =========================
@router.on_event("startup")
async def startup_event():
    asyncio.create_task(stream_loop())