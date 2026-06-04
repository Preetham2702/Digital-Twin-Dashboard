import websocket
import json

# 🔥 CHANGE THIS
PRINTER_IP = "10.106.89.35"
WS_URL = f"ws://{PRINTER_IP}:3030"   # try different if needed

def on_message(ws, message):
    print("\n--- RAW MESSAGE ---")
    print(message)

    try:
        data = json.loads(message)
        print("\n--- PARSED JSON ---")
        print(json.dumps(data, indent=2))
    except:
        print("⚠️ Not JSON (may be binary or encoded)")

def on_error(ws, error):
    print("❌ ERROR:", error)

def on_close(ws, close_status_code, close_msg):
    print("🔌 Connection Closed")

def on_open(ws):
    print("✅ Connected to printer")

    # ⚠️ Try handshake messages (one at a time)
    try:
        ws.send(json.dumps({"cmd": "get_status"}))
        print("📤 Sent get_status")
    except:
        pass

if __name__ == "__main__":
    print(f"Connecting to {WS_URL}...\n")

    ws = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )

    ws.run_forever()