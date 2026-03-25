import asyncio
import linuxcnc
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from typing import Set
import os

router = APIRouter()

# =========================
# CNC INIT
# =========================
s = linuxcnc.stat()
c = linuxcnc.command()

connected_clients: Set[WebSocket] = set()
latest_status = {}

UPLOAD_DIR = "gcode_files"
os.makedirs(UPLOAD_DIR, exist_ok=True)


# =========================
# STATE MAPPING
# =========================
def map_state(state):
    mapping = {
        1: "Idle",
        2: "Running",
        3: "Paused",
        4: "Stopped"
    }
    return mapping.get(state, "Unknown")


# =========================
# WEBSOCKET
# =========================
@router.websocket("/ws/pocketnc")
async def pocketnc_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    # send last data
    if latest_status:
        await websocket.send_json(latest_status)

    try:
        while True:
            await websocket.receive_text()
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
# LIVE POLLING LOOP
# =========================
async def poll_cnc():
    global latest_status

    while True:
        try:
            s.poll()

            latest_status = {
                "machine": "PocketNC",
                "state": map_state(s.task_state),
                "position": {
                    "x": round(s.position[0], 3),
                    "y": round(s.position[1], 3),
                    "z": round(s.position[2], 3),
                },
                "spindle_speed": s.spindle[0]['speed'],
                "feed_rate": s.feedrate,
                "line": s.motion_line,
                "file": s.file,
                "tool": s.tool_in_spindle,
            }

            await broadcast(latest_status)

        except Exception as e:
            print("CNC Error:", e)

        await asyncio.sleep(0.3)


# =========================
# START LOOP
# =========================
@router.on_event("startup")
async def startup_event():
    asyncio.create_task(poll_cnc())


# =========================
# CONTROL APIs
# =========================
@router.post("/pocketnc/start")
def start():
    c.auto(linuxcnc.AUTO_RUN)
    return {"status": "started"}


@router.post("/pocketnc/pause")
def pause():
    c.auto(linuxcnc.AUTO_PAUSE)
    return {"status": "paused"}


@router.post("/pocketnc/resume")
def resume():
    c.auto(linuxcnc.AUTO_RESUME)
    return {"status": "resumed"}


@router.post("/pocketnc/stop")
def stop():
    c.abort()
    return {"status": "stopped"}


# =========================
# UPLOAD + LOAD FILE
# =========================
@router.post("/pocketnc/upload")
async def upload(file: UploadFile = File(...)):
    filepath = os.path.join(UPLOAD_DIR, file.filename)

    with open(filepath, "wb") as f:
        f.write(await file.read())

    c.program_open(filepath)

    return {"status": "uploaded & loaded", "file": file.filename}