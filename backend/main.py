from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import httpx
from typing import Set

PRINTER_IP = ""
BASE_URL = f"http://{PRINTER_IP}:7125"
PRINTER_STREAM_URL = f"{BASE_URL}/webcam/?action=stream"

POLL_INTERVAL = 2

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

connected_clients: Set[WebSocket] = set()
latest_status = {}
moonraker_connected = False


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


async def broadcast(data):
    dead = []
    for client in connected_clients:
        try:
            await client.send_json(data)
        except:
            dead.append(client)

    for d in dead:
        connected_clients.remove(d)


@app.websocket("/ws/printer")
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


# 🔥 Robust polling with automatic retry
async def poll_printer():
    global latest_status, moonraker_connected

    await asyncio.sleep(5)  # give printer time to boot

    async with httpx.AsyncClient(timeout=5.0) as client:
        while True:
            try:
                response = await client.get(f"{BASE_URL}/printer/info")

                if response.status_code != 200:
                    raise Exception("Printer not ready")

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

                print("✅ Connected to printer")

                await broadcast(latest_status)

            except Exception as e:
                moonraker_connected = False
                print("⏳ Waiting for printer...")

                await broadcast({
                    "moonraker_connected": False,
                    "ui_state": "Disconnected"
                })

            await asyncio.sleep(POLL_INTERVAL)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(poll_printer())


@app.get("/video_feed")
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


@app.post("/upload")
async def upload_gcode(file: UploadFile = File(...)):
    content = await file.read()

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{BASE_URL}/server/files/upload",
            files={"file": (file.filename, content)},
            data={"root": "gcodes"},
        )

    return {"status": response.is_success}


@app.post("/start/{filename}")
async def start_print(filename: str):
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{BASE_URL}/printer/print/start",
            json={"filename": filename}
        )

    return {"status": response.is_success}


@app.post("/stop")
async def stop_print():
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{BASE_URL}/printer/print/cancel"
        )

    return {"status": response.is_success}