"""
Elegoo Saturn 4 Ultra — SDCP WebSocket Status Extractor (Fixed)
The printer sends status as PUSH messages, not direct replies.
We keep the WebSocket open and listen for all incoming messages.

Usage:
    python3 sdcp_status.py           # listen for 30s
    python3 sdcp_status.py --watch   # listen forever
"""

import socket
import json
import uuid
import time
import sys

PRINTER_IP = "10.106.89.35"


# ── Step 1: Get MainboardID via UDP ───────────────────────────────────────────
def get_printer_info():
    print(f"[*] Discovering printer at {PRINTER_IP} ...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(5)
    try:
        sock.sendto(b'M99999', (PRINTER_IP, 3000))
        data, _ = sock.recvfrom(4096)
        info = json.loads(data)
        mainboard_id = info["Data"]["MainboardID"]
        print(f"[+] Printer : {info['Data']['MachineName']}")
        print(f"[+] ID      : {mainboard_id}")
        print(f"[+] Protocol: {info['Data']['ProtocolVersion']}")
        return mainboard_id
    except Exception as e:
        print(f"[!] Discovery failed: {e}")
        sys.exit(1)
    finally:
        sock.close()


# ── Step 2: Connect and listen ────────────────────────────────────────────────
def listen(mainboard_id, duration=60):
    try:
        import websocket
    except ImportError:
        print("[!] Run:  pip3 install websocket-client")
        sys.exit(1)

    ws_url = f"ws://{PRINTER_IP}:3030/websocket"
    print(f"\n[*] Connecting to {ws_url}")
    print(f"[*] Listening for {duration}s — Ctrl-C to stop\n")

    def make_cmd(cmd_id):
        return json.dumps({
            "Id": uuid.uuid4().hex,
            "Data": {
                "Cmd": cmd_id,
                "Data": {},
                "From": 0,
                "MainboardID": mainboard_id,
                "RequestID": uuid.uuid4().hex,
                "TimeStamp": int(time.time() * 1000)
            },
            "Topic": f"sdcp/request/{mainboard_id}"
        })

    try:
        ws = websocket.create_connection(ws_url, timeout=10)
        print("[+] Connected!\n")

        # Send multiple command types to trigger responses
        for cmd_id in [0, 1, 256, 512]:
            ws.send(make_cmd(cmd_id))
            time.sleep(0.2)

        # Listen for ALL incoming messages
        ws.settimeout(3)
        deadline = time.time() + duration
        msg_count = 0

        while time.time() < deadline:
            try:
                raw = ws.recv()
                if not raw:
                    continue

                msg_count += 1
                print(f"[{time.strftime('%H:%M:%S')}] Message #{msg_count}:")

                try:
                    data = json.loads(raw)
                    print(json.dumps(data, indent=2))
                    parse_and_display(data)
                except json.JSONDecodeError:
                    print(f"  Raw: {raw[:200]}")

                print()

                # Re-send status request every 5s to keep data flowing
                if msg_count % 5 == 0:
                    ws.send(make_cmd(0))

            except websocket.WebSocketTimeoutException:
                # Send a ping to keep connection alive
                ws.send(make_cmd(0))
            except Exception as e:
                print(f"[!] Receive error: {e}")
                break

        ws.close()
        if msg_count == 0:
            print("[!] No messages received — printer may need to be actively printing")

    except Exception as e:
        print(f"[!] Connection error: {e}")


# ── Parse known fields ─────────────────────────────────────────────────────────
def parse_and_display(data):
    try:
        inner = data.get("Data", {}).get("Data", {})
        if not inner or inner == {"Ack": 0}:
            return

        # Status data
        current_status = inner.get("CurrentStatus")
        prev_status    = inner.get("PreviousStatus")
        print_info     = inner.get("PrintInfo", {})
        attrs          = inner.get("Attributes", {})
        temp_info      = inner.get("TempInfo", {})

        status_map = {0: "IDLE", 1: "PRINTING", 2: "FILE_TRANSFER", 4: "EXPOSURE", 8: "PAUSED", 16: "STOPPING"}

        print("  ┌─── PARSED ─────────────────────────────")
        if attrs:
            print(f"  │ Machine  : {attrs.get('MachineName', '—')}")
            print(f"  │ Firmware : {attrs.get('FirmwareVersion', '—')}")
        if current_status is not None:
            print(f"  │ Status   : {status_map.get(current_status, current_status)}")
        if print_info:
            print(f"  │ File     : {print_info.get('Filename', '—')}")
            print(f"  │ Layer    : {print_info.get('CurrentLayer', '—')} / {print_info.get('TotalLayer', '—')}")
            ticks     = print_info.get('CurrentTicks', 0)
            total     = print_info.get('TotalTicks', 0)
            if total > 0:
                pct = round(ticks / total * 100, 1)
                print(f"  │ Progress : {pct}%")
            print(f"  │ Error    : {print_info.get('ErrorNumber', 0)}")
        if temp_info:
            print(f"  │ UV Temp  : {temp_info.get('TempOfUVLED', '—')} °C")
            print(f"  │ Box Temp : {temp_info.get('TempOfBox', '—')} °C")
        print("  └────────────────────────────────────────")
    except Exception:
        pass


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    watch = "--watch" in sys.argv
    mainboard_id = get_printer_info()

    if watch:
        while True:
            try:
                listen(mainboard_id, duration=3600)
            except KeyboardInterrupt:
                print("\n[*] Stopped.")
                break
    else:
        listen(mainboard_id, duration=30)