"""
Elegoo Saturn 4 Ultra — Step 4: Protocol Sniffing
If your firmware version uses different field names or command IDs,
this script captures and decodes all printer traffic so you can map
the fields yourself.

Requirements:
  pip install scapy     (packet capture)
  OR: use the Wireshark filter below without any Python deps

Wireshark capture filter (paste in "Capture Filter" box):
  host <printer_ip> and tcp port 3000

Wireshark display filter after capture:
  tcp.port == 3000 && data

Then: Analyze → Follow → TCP Stream to see the raw exchange.
"""

import json
import struct
import socket
import threading
import time
from typing import Callable, Optional


# ── Pure-Python TCP interceptor (no scapy needed) ────────────────────────────
# Acts as a transparent proxy: you connect to this script, it forwards
# to the printer, and logs every packet in both directions.

class TCPInterceptor:
    """
    Transparent TCP proxy that logs all packets between a client and the printer.

    Start it, then point your app (or ChiTuBox slicer) at
    127.0.0.1:LISTEN_PORT and it will forward everything to the real printer
    while printing every packet to stdout.

    Usage:
        proxy = TCPInterceptor("192.168.1.42", listen_port=13000)
        proxy.start()
        # Now connect your client to localhost:13000
    """

    def __init__(
        self,
        printer_ip:   str,
        printer_port: int = 3000,
        listen_port:  int = 13000,
        on_packet:    Optional[Callable[[str, bytes], None]] = None,
    ):
        self.printer_ip   = printer_ip
        self.printer_port = printer_port
        self.listen_port  = listen_port
        self.on_packet    = on_packet or self._default_logger
        self._running     = False

    def _default_logger(self, direction: str, data: bytes):
        """Default: try to decode as length-prefixed JSON, fall back to hex."""
        print(f"\n{'─'*60}")
        print(f"[{direction}] {len(data)} bytes  {time.strftime('%H:%M:%S')}")

        # Try length-prefixed packet
        if len(data) >= 4:
            try:
                length = struct.unpack("<I", data[:4])[0]
                payload = data[4:4 + length]
                try:
                    decoded = json.loads(payload.decode("utf-8"))
                    print(f"  JSON payload: {json.dumps(decoded, indent=4)}")
                    return
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
                print(f"  Binary payload ({length} B): {payload[:64].hex()} ...")
                return
            except struct.error:
                pass

        # Raw hex
        print(f"  Raw hex: {data[:128].hex()} ...")

    def _handle_client(self, client_sock: socket.socket):
        try:
            printer_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            printer_sock.connect((self.printer_ip, self.printer_port))
        except OSError as e:
            print(f"[Interceptor] Cannot reach printer: {e}")
            client_sock.close()
            return

        def forward(src, dst, direction):
            try:
                while self._running:
                    data = src.recv(65536)
                    if not data:
                        break
                    self.on_packet(direction, data)
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                src.close()
                dst.close()

        t1 = threading.Thread(target=forward, args=(client_sock, printer_sock, "CLIENT→PRINTER"), daemon=True)
        t2 = threading.Thread(target=forward, args=(printer_sock, client_sock, "PRINTER→CLIENT"), daemon=True)
        t1.start()
        t2.start()

    def start(self, blocking: bool = False):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", self.listen_port))
        server.listen(5)
        self._running = True
        print(f"[Interceptor] Listening on 127.0.0.1:{self.listen_port}")
        print(f"[Interceptor] Forwarding to {self.printer_ip}:{self.printer_port}")
        print(f"[Interceptor] Ctrl-C to stop\n")

        def accept_loop():
            while self._running:
                try:
                    client, addr = server.accept()
                    print(f"[Interceptor] New connection from {addr}")
                    threading.Thread(
                        target=self._handle_client, args=(client,), daemon=True
                    ).start()
                except OSError:
                    break

        if blocking:
            accept_loop()
        else:
            threading.Thread(target=accept_loop, daemon=True).start()

    def stop(self):
        self._running = False


# ── Passive UDP sniffer ────────────────────────────────────────────────────────

def sniff_udp_beacons(duration: float = 30.0):
    """
    Listen for raw UDP packets on port 3000 and dump everything.
    Helps you map the exact broadcast format for your firmware version.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("", 3000))
    sock.settimeout(1.0)

    print(f"[UDP Sniffer] Listening for {duration}s ...")
    deadline = time.time() + duration
    seen: set[str] = set()

    while time.time() < deadline:
        try:
            data, addr = sock.recvfrom(4096)
            sig = data[:16].hex()
            if sig not in seen:
                seen.add(sig)
                print(f"\n[{addr[0]}] {len(data)} bytes")
                print(f"  Hex:  {data.hex()}")
                try:
                    text = data.decode("utf-8").strip("\x00")
                    print(f"  Text: {text}")
                    try:
                        j = json.loads(text)
                        print(f"  JSON: {json.dumps(j, indent=4)}")
                    except json.JSONDecodeError:
                        pass
                except UnicodeDecodeError:
                    pass
        except socket.timeout:
            pass

    sock.close()


# ── Brute-force command scanner ───────────────────────────────────────────────

def scan_commands(
    ip:          str,
    port:        int   = 3000,
    cmd_range:   range = range(0, 512),
    timeout:     float = 2.0,
    stop_on_err: bool  = True,
) -> dict[int, dict]:
    """
    Iterate through Cmd IDs and record which ones get a non-error response.
    CAUTION: Some commands may alter printer state (start print, move Z, etc.).
    Run only when the printer is IDLE and no print bed is loaded.

    Returns a dict of {cmd_id: response_dict}.
    """
    results = {}
    print(f"[Scanner] Scanning Cmd IDs {cmd_range.start}–{cmd_range.stop-1} on {ip}:{port}")
    print("[Scanner] Press Ctrl-C to stop at any time\n")

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect((ip, port))

            for cmd_id in cmd_range:
                payload = json.dumps({"Cmd": cmd_id, "Data": {"Uid": 0}}).encode()
                packet  = struct.pack("<I", len(payload)) + payload
                try:
                    sock.sendall(packet)
                    header = b""
                    while len(header) < 4:
                        chunk = sock.recv(4 - len(header))
                        if not chunk:
                            raise ConnectionError("Disconnected")
                        header += chunk
                    length = struct.unpack("<I", header)[0]
                    body = b""
                    while len(body) < min(length, 8192):
                        chunk = sock.recv(min(length - len(body), 4096))
                        if not chunk:
                            break
                        body += chunk

                    try:
                        resp = json.loads(body.decode("utf-8"))
                    except Exception:
                        resp = {"_hex": body[:64].hex()}

                    # Skip empty / error responses to keep output clean
                    has_data = resp.get("Data") not in (None, {}, [])
                    err_flag = resp.get("Ack", 0) != 0

                    if has_data and not err_flag:
                        results[cmd_id] = resp
                        print(f"  [Cmd {cmd_id:4d}] → {resp}")

                except (socket.timeout, ConnectionError) as e:
                    if stop_on_err:
                        print(f"  [Cmd {cmd_id:4d}] Connection lost: {e}")
                        break
                    # Re-connect on timeout
                    try:
                        sock.close()
                        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        sock.settimeout(timeout)
                        sock.connect((ip, port))
                    except OSError:
                        break

    except KeyboardInterrupt:
        print("\n[Scanner] Stopped by user")

    print(f"\n[Scanner] Found {len(results)} responding commands")
    return results


# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    mode = sys.argv[1] if len(sys.argv) > 1 else "sniff"

    if mode == "proxy":
        ip = sys.argv[2] if len(sys.argv) > 2 else None
        if not ip:
            print("Usage: python sniffer.py proxy <printer_ip>")
            sys.exit(1)
        interceptor = TCPInterceptor(ip)
        interceptor.start(blocking=True)

    elif mode == "scan":
        ip = sys.argv[2] if len(sys.argv) > 2 else None
        if not ip:
            print("Usage: python sniffer.py scan <printer_ip>")
            sys.exit(1)
        results = scan_commands(ip, cmd_range=range(0, 300))
        with open("cmd_scan_results.json", "w") as f:
            json.dump(results, f, indent=2)
        print(f"Results saved to cmd_scan_results.json")

    else:
        print("Sniffing UDP beacons for 30s ...")
        sniff_udp_beacons(30.0)