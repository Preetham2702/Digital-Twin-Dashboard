"""
Elegoo Saturn 4 Ultra — Step 1: Discovery
Finds the printer on your local network via:
  - UDP broadcast listener (Chitu firmware beacons on port 3000)
  - mDNS / zeroconf scan
  - Subnet ARP sweep fallback
"""

import socket
import struct
import json
import time
import threading
from dataclasses import dataclass, asdict
from typing import Optional


CHITU_UDP_PORT  = 3000
CHITU_BROADCAST = "255.255.255.255"
DISCOVERY_MAGIC = b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x00\x00\x00"


@dataclass
class PrinterInfo:
    ip: str
    port: int
    machine_name: str = "Unknown"
    machine_type: str = "Unknown"
    brand_name: str = "Elegoo"
    protocol_version: str = "Unknown"
    firmware_version: str = "Unknown"
    discovery_method: str = "udp"

    def to_dict(self):
        return asdict(self)


# ── UDP beacon listener ────────────────────────────────────────────────────────

def _parse_udp_beacon(data: bytes, addr: tuple) -> Optional[PrinterInfo]:
    """
    Chitu firmware broadcasts a UDP packet every ~3 s.
    Newer Saturn 4 Ultra firmware sends a JSON payload; older ones send
    a binary struct. We handle both.
    """
    ip, port = addr

    # Try JSON first (firmware v4+)
    try:
        text = data.decode("utf-8").strip("\x00")
        payload = json.loads(text)
        return PrinterInfo(
            ip=ip,
            port=payload.get("Port", CHITU_UDP_PORT),
            machine_name=payload.get("Name", payload.get("MachineName", "Unknown")),
            machine_type=payload.get("MachineType", "Unknown"),
            brand_name=payload.get("BrandName", "Elegoo"),
            protocol_version=str(payload.get("ProtocolVersion", "Unknown")),
            firmware_version=str(payload.get("FirmwareVersion", "Unknown")),
            discovery_method="udp-json",
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass

    # Binary struct fallback (older firmware)
    # Magic(14) + MachineNameLen(2) + MachineName(N) + ...
    if len(data) >= 16:
        try:
            name_len = struct.unpack_from(">H", data, 14)[0]
            if name_len > 0 and 16 + name_len <= len(data):
                machine_name = data[16 : 16 + name_len].decode("utf-8", errors="replace")
                return PrinterInfo(
                    ip=ip,
                    port=CHITU_UDP_PORT,
                    machine_name=machine_name,
                    discovery_method="udp-binary",
                )
        except Exception:
            pass

    # Unknown format — still report the IP
    return PrinterInfo(ip=ip, port=CHITU_UDP_PORT, discovery_method="udp-unknown")


def listen_for_beacons(timeout: float = 10.0) -> list[PrinterInfo]:
    """
    Open a UDP socket bound to port 3000 and collect all Chitu beacons
    received within `timeout` seconds.
    """
    printers: dict[str, PrinterInfo] = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(1.0)

    try:
        sock.bind(("", CHITU_UDP_PORT))
        print(f"[UDP] Listening for Chitu beacons on port {CHITU_UDP_PORT} ...")
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
                ip = addr[0]
                if ip not in printers:
                    info = _parse_udp_beacon(data, addr)
                    if info:
                        printers[ip] = info
                        print(f"  [+] Found: {ip}  name={info.machine_name}  method={info.discovery_method}")
            except socket.timeout:
                pass
    finally:
        sock.close()

    return list(printers.values())


# ── Active probe (we send a discovery packet, printer replies) ─────────────────

def probe_ip(ip: str, port: int = CHITU_UDP_PORT, timeout: float = 2.0) -> Optional[PrinterInfo]:
    """
    Send a discovery probe to a known IP and wait for the printer to reply.
    Useful when you already know the IP but the beacon hasn't arrived yet.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        # Some firmware versions respond to a 0-filled probe
        sock.sendto(DISCOVERY_MAGIC, (ip, port))
        data, addr = sock.recvfrom(4096)
        info = _parse_udp_beacon(data, addr)
        if info:
            info.discovery_method = "probe"
        return info
    except (socket.timeout, OSError):
        return None
    finally:
        sock.close()


# ── mDNS / Zeroconf ───────────────────────────────────────────────────────────

def discover_mdns(timeout: float = 5.0) -> list[PrinterInfo]:
    """
    Scan for Chitu/Elegoo printers via mDNS.
    Requires:  pip install zeroconf
    Falls back gracefully if the library is not installed.
    """
    try:
        from zeroconf import Zeroconf, ServiceBrowser

        printers: list[PrinterInfo] = []
        lock = threading.Lock()

        class Handler:
            SERVICE_TYPES = [
                "_chitubox._tcp.local.",
                "_elegoo._tcp.local.",
                "_printer._tcp.local.",
            ]

            def add_service(self, zc, type_, name):
                info = zc.get_service_info(type_, name)
                if info:
                    ip = socket.inet_ntoa(info.addresses[0]) if info.addresses else "?"
                    with lock:
                        printers.append(
                            PrinterInfo(
                                ip=ip,
                                port=info.port or CHITU_UDP_PORT,
                                machine_name=info.name,
                                discovery_method="mdns",
                            )
                        )
                        print(f"  [mDNS] {ip}:{info.port}  {info.name}")

            def remove_service(self, *_): pass
            def update_service(self, *_): pass

        zc = Zeroconf()
        handler = Handler()
        browsers = [ServiceBrowser(zc, svc, handler) for svc in Handler.SERVICE_TYPES]
        time.sleep(timeout)
        zc.close()
        return printers

    except ImportError:
        print("[mDNS] 'zeroconf' not installed — skipping. (pip install zeroconf)")
        return []


# ── Combined discovery ─────────────────────────────────────────────────────────

def discover_printers(timeout: float = 10.0) -> list[PrinterInfo]:
    """Run all discovery methods and return deduplicated results."""
    found: dict[str, PrinterInfo] = {}

    # Passive UDP beacon
    for p in listen_for_beacons(timeout):
        found[p.ip] = p

    # mDNS (parallel — runs during the UDP window via thread)
    # Already collected above; add any new IPs
    for p in discover_mdns(3.0):
        if p.ip not in found:
            found[p.ip] = p

    return list(found.values())


if __name__ == "__main__":
    results = discover_printers(timeout=10)
    if results:
        print("\n=== Discovered printers ===")
        for p in results:
            print(json.dumps(p.to_dict(), indent=2))
    else:
        print("\n[!] No printers found. Make sure you're on the same network.")
        print("    Try: python discover.py --probe 192.168.1.X")