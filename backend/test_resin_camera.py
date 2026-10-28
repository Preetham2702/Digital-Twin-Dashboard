"""
Standalone resin camera check. Run from backend/:  python3 test_resin_camera.py
1) Discovers the printer (UDP 3000) using RESIN_PRINTER_IP from .env
2) Opens SDCP websocket, sends Cmd 386 {"Enable": 1}, prints the raw reply
3) Probes the RTSP URL(s) with a hard timeout and prints what ffmpeg saw
"""
import os, json, time, uuid, socket, subprocess
from dotenv import load_dotenv
import websocket

load_dotenv()
IP = os.getenv("RESIN_PRINTER_IP")
print(f"[TEST] Printer IP from .env: {IP}")

# 1) discovery
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5)
s.sendto(b"M99999", (IP, 3000))
info = json.loads(s.recvfrom(4096)[0])["Data"]
mid = info["MainboardID"]
print(f"[TEST] {info.get('MachineName')} | FW {info.get('FirmwareVersion')} | ID {mid}")

import sys
COUNT_ONLY = "--count" in sys.argv   # just read the stream counter, touch nothing

# 2) SDCP: enable video and dump replies
ws = websocket.create_connection(f"ws://{IP}:3030/websocket", timeout=5)
def cmd(c, data=None):
    ws.send(json.dumps({"Id": uuid.uuid4().hex, "Data": {"Cmd": c, "Data": data or {},
        "From": 0, "MainboardID": mid, "RequestID": uuid.uuid4().hex,
        "TimeStamp": int(time.time() * 1000)}, "Topic": f"sdcp/request/{mid}"}))

cmd(1)                      # attributes (contains camera / stream info)
if not COUNT_ONLY:
    cmd(386, {"Enable": 1}) # enable video stream
video_url = None
end = time.time() + (2 if COUNT_ONLY else 6)
while time.time() < end:
    try:
        raw = ws.recv()
    except websocket.WebSocketTimeoutException:
        break
    d = json.loads(raw)
    inner = d.get("Data", {})
    if inner.get("Cmd") == 386:
        print(f"[TEST] Cmd 386 reply: {json.dumps(inner.get('Data'))}")
        video_url = inner.get("Data", {}).get("VideoUrl")
    if "Attributes" in d:
        a = d["Attributes"]
        keys = {k: v for k, v in a.items() if any(x in k.lower() for x in ("video", "camera", "stream", "capab"))}
        print(f"[TEST] Attributes (camera-related): {json.dumps(keys)}")

if COUNT_ONLY:
    ws.close()
    sys.exit(0)

# 3) probe RTSP with a hard timeout
urls = []
if video_url:
    urls.append(video_url if "://" in video_url else f"rtsp://{video_url}")
urls += [f"rtsp://{IP}:554/video"]
seen = set()
for u in urls:
    if u in seen: continue
    seen.add(u)
    print(f"\n[TEST] Probing {u} (8s max) ...")
    try:
        r = subprocess.run(["ffprobe", "-v", "verbose", "-rtsp_transport", "udp",
                            "-timeout", "5000000", "-i", u],
                           capture_output=True, text=True, timeout=8)
        out = (r.stderr or "").strip().splitlines()
        print(f"[TEST] exit {r.returncode}")
        print("\n".join(out[-8:]))
    except subprocess.TimeoutExpired as e:
        tail = (e.stderr.decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")).strip().splitlines()
        print("[TEST] ❌ TIMED OUT — server accepted TCP but sent no video")
        print("\n".join(tail[-8:]) or "(no ffprobe output)")

# give the stream slot back so the test never leaks one
cmd(386, {"Enable": 0})
time.sleep(0.3)
ws.close()
print("\n[TEST] Released video slot (Cmd 386 Enable 0)")
