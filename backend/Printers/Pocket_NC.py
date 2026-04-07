from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import socket
import json
from typing import Set
from fastapi import HTTPException

router = APIRouter()

connected_clients: Set[WebSocket] = set()

# 👉 Use hostname if possible (better than changing IP)
POCKETNC_IP ="pocketnc.local"
PORT = 5000
CONTROL_PORT = 5002
current_file = None
DRY_RUN = False 

state_map = {
    1: "Estop",
    2: "Estop Reset",
    3: "Off",
    4: "On",
    5: "Running",
    6: "Paused"
}

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
                            "s_value": raw.get("s_value", 0),
                            "f_value": raw.get("f_value", 0),
                            "toolhead": {
                                "position": [
                                    raw.get("x", 0),
                                    raw.get("y", 0),
                                    raw.get("z", 0),
                                    raw.get("a", 0),
                                    raw.get("b", 0),
                                ]
                            },
                            "interp_state": raw.get("interp_state", 0),
                            "current_line": raw.get("line", 0),
                            "current_file": raw.get("file", ""),
                            "active_gcodes": raw.get("active_gcodes", ""),
                            "machine_state": state_map.get(raw.get("state"), "Unknown")
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


def send_control(command):
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)

        sock.connect((POCKETNC_IP, CONTROL_PORT))

        sock.sendall(json.dumps(command).encode())

        # 🔥 read ONCE (not infinite loop)
        data = sock.recv(4096)

        sock.close()

        print("CONTROL RESPONSE:", data)

        if not data:
            return {"status": "no response"}

        return json.loads(data.decode())

    except Exception as e:
        print("Control error:", e)
        return {"error": str(e)}


def is_connected():
    try:
        sock = socket.socket()
        sock.settimeout(1)
        sock.connect((POCKETNC_IP, CONTROL_PORT))
        sock.close()
        return True
    except:
        return False


def safe_range(value, min_v, max_v):
    return min_v <= value <= max_v



@router.post("/pocketnc/load")
def load_file(file: str):
    global current_file

    if not file:
        raise HTTPException(status_code=400, detail="No file provided")

    current_file = file

    return send_control({
        "action": "load",
        "file": file
    })

@router.get("/pocketnc/files")
def list_files():
    response = send_control({"action": "list_files"})

    print("FILES RESPONSE:", response)  # 🔥 debug

    if not response or "error" in response:
        return {"files": []}

    return {"files": response.get("files", [])}

@router.post("/pocketnc/start")
def start():
    print("🔥 START ENDPOINT HIT")

    if not is_connected():
        print("❌ NOT CONNECTED")
        return {"error": "Machine not connected"}

    print("👉 SENDING START COMMAND")

    res = send_control({"action": "start"})

    print("RESPONSE:", res)

    return res

@router.post("/pocketnc/pause")
def pause():
    return send_control({"action": "pause"})


@router.post("/pocketnc/stop")
def stop():
    return send_control({"action": "stop"})


@router.post("/pocketnc/estop")
def estop():
    return send_control({"action": "estop"})



@router.post("/pocketnc/feed")
def set_feed(value: float):
    if not safe_range(value, 0.5, 2.0):
        return {"error": "Feed must be between 0.5 and 1.5"}

    return send_control({
        "action": "feed_override",
        "value": value
    })


@router.post("/pocketnc/spindle")
def set_spindle(value: float):
    if not safe_range(value, 0.5, 2.0):
        return {"error": "Spindle must be between 0.5 and 1.5"}

    return send_control({
        "action": "spindle_override",
        "value": value
    })


@router.post("/pocketnc/velocity")
def set_rapid(value: float):
    if not safe_range(value, 0.5, 2.0):
        return {"error": "Rapid must be between 0.5 and 1.5"}

    return send_control({
        "action":  "rapid_override",
        "value": value
    })

@router.post("/pocketnc/set-line")
def set_line(line: int):
    return send_control({"action": "set_line", "line": line})


@router.get("/pocketnc/file-content")
def get_file_content(file: str):
    try:
        path = f"/home/pocketnc/machinekit/nc_files/{file}"   # 🔥 FIXED

        with open(path, "r") as f:
            lines = f.readlines()

        return {"lines": [l.strip() for l in lines]}

    except Exception as e:
        return {"error": str(e)}


@router.post("/pocketnc/home")
def home_axis(axis: str):
    return send_control({"action": "home", "axis": axis})