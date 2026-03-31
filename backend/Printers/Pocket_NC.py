from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import websockets
import json
from typing import Set

router = APIRouter()

WS_URL = "ws://192.168.7.2:8000/websocket/linuxcnc"
WS_PROTOCOL = "linuxcnc"

connected_clients: Set[WebSocket] = set()
latest_status = {}


@router.websocket("/ws/pocketnc")
async def pocketnc_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    if latest_status:
        await websocket.send_json(latest_status)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.remove(websocket)



async def broadcast(data):
    dead = []
    for client in connected_clients:
        try:
            await client.send_json(data)
        except:
            dead.append(client)

    for d in dead:
        connected_clients.remove(d)


async def listen_to_pocketnc():
    global latest_status

    while True:
        try:
            async with websockets.connect(
                WS_URL,
                subprotocols=[WS_PROTOCOL]
            ) as ws:

                print("✅ Connected to PocketNC")

                #LOGIN
                await ws.send(json.dumps({
                    "id": "Login",
                    "user": "default",
                    "password": "default"
                }))

                while True:
                    msg = await ws.recv()
                    res = json.loads(msg)

                    #Login success
                    if res.get("id") == "Login" and res.get("code") == "?OK":
                        print("✅ Logged in")

                        # Start watching RPM
                        await ws.send(json.dumps({
                            "id": "rpm",
                            "command": "watch",
                            "name": "halpin_spindle_voltage.speed_measured"
                        }))

                    #Live RPM
                    if res.get("id") == "rpm" and "data" in res:
                        rpm = float(res["data"])

                        latest_status = {
                            "machine": "PocketNC",
                            "connected": True,
                            "rpm": rpm
                        }

                        print(f"RPM: {rpm}")

                        await broadcast(latest_status)

        except Exception as e:
            print("❌ PocketNC Disconnected:", e)

            await broadcast({
                "machine": "PocketNC",
                "connected": False
            })

            await asyncio.sleep(5)


@router.on_event("startup")
async def startup_event():
    asyncio.create_task(listen_to_pocketnc())