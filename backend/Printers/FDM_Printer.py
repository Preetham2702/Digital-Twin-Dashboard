from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse
import asyncio
import httpx
from typing import Set
import urllib.parse
import os
from dotenv import load_dotenv
import urllib.parse

load_dotenv()

PRINTER_IP = os.getenv("FDM_PRINTER_IP")
if not PRINTER_IP:
    raise ValueError("FDM_PRINTER_IP not set in .env file")
BASE_URL = f"http://{PRINTER_IP}:7125"
PRINTER_STREAM_URL = f"http://{PRINTER_IP}:8080/?action=stream"

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

    for ws in connected_clients:
        try:
            await ws.send_json(data)
        except:
            dead.append(ws)

    for d in dead:
        connected_clients.remove(d)


# =========================
# WEBSOCKET
# =========================
@router.websocket("/ws/printer")
async def printer_ws(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    print("✅ FDM connected")

    try:
        # optional initial send
        if latest_status:
            try:
                await websocket.send_json(latest_status)
            except:
                pass

        while True:
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                break   

    except Exception as e:
        print("WS error:", e)

    finally:
        print("❌ FDM client disconnected")
        if websocket in connected_clients:
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
                    "raw_status": status,
                    "file_position": status.get("virtual_sdcard", {}).get("file_position", 0)
                }

                print(f"✅ Stable(FDM) | {ui_state}")

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
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{BASE_URL}/server/files/list",
                params={"root": "gcodes"}
            )

        data = response.json()



        # 🔥 HANDLE FORMAT SAFELY
        if isinstance(data, list):
            files_data = data

        elif isinstance(data, dict):
            if "result" in data:
                if isinstance(data["result"], list):
                    files_data = data["result"]
                else:
                    files_data = data["result"].get("files", [])
            else:
                files_data = data.get("files", [])
        else:
            files_data = []

        files = []
        for item in files_data:
            if isinstance(item, dict):
                path = item.get("path", "")
                if path.endswith(".gcode") or path.endswith(".g"):
                    files.append(path)

        return {"files": files}

    except Exception as e:
        print("File list error:", e)
        return {"files": []}
        

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
def video_feed():
    def generate():
        try:
            with requests.get(PRINTER_STREAM_URL, stream=True) as r:
                for chunk in r.raw:
                    yield chunk
        except Exception as e:
            print("Stream error:", e)

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=--frame"
    )

@router.get("/gcode")
async def get_gcode(file: str):
    try:
        import urllib.parse

        # 🔥 CLEAN FILE
        clean_file = file.replace(".cache/", "").strip()

        # 🔥 ENCODE
        safe_file = urllib.parse.quote(clean_file)

        print("REQUESTING GCODE:", safe_file)

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{BASE_URL}/server/files/gcodes/{safe_file}"
            )

        if not response.is_success:
            print("Moonraker error:", response.text)
            return ""

        return response.text

    except Exception as e:
        print("GCODE fetch error:", e)
        return ""