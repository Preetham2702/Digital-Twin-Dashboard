"""
Elegoo Saturn 4 Ultra — Step 2: TCP Status Extraction
Connects to the printer's TCP server (port 3000) and extracts the full
status payload: print progress, layer info, temps, error codes, etc.

Protocol notes:
  - All packets: [4-byte little-endian length][payload]
  - Payload is a JSON object on firmware v4+, binary struct on older fw
  - The printer accepts commands and sends responses with the same framing
"""

import socket
import json
import struct
import time
from dataclasses import dataclass, field, asdict
from typing import Optional, Any

CHITU_TCP_PORT = 3000

# ── Status data structures ────────────────────────────────────────────────────

@dataclass
class LayerInfo:
    current_layer:   int   = 0
    total_layers:    int   = 0
    layer_height_mm: float = 0.0
    z_position_mm:   float = 0.0

@dataclass
class ExposureInfo:
    exposure_time_s:     float = 0.0
    bottom_layers:       int   = 0
    bottom_exposure_s:   float = 0.0
    uv_power_percent:    int   = 0
    anti_alias_level:    int   = 0

@dataclass
class TemperatureInfo:
    uvled_temp_c:    float = 0.0
    enclosure_temp_c: float = 0.0

@dataclass
class PrintStatus:
    # Machine identity
    machine_name:      str = ""
    machine_status:    str = ""   # "IDLE" | "PRINTING" | "PAUSED" | "STOP" | "FINISHED"
    firmware_version:  str = ""
    protocol_version:  str = ""

    # Current file
    current_file:      str = ""
    print_id:          str = ""

    # Timing
    print_time_s:      int   = 0
    remaining_time_s:  int   = 0
    elapsed_percent:   float = 0.0

    # Sub-structures
    layer:       LayerInfo      = field(default_factory=LayerInfo)
    exposure:    ExposureInfo   = field(default_factory=ExposureInfo)
    temperature: TemperatureInfo = field(default_factory=TemperatureInfo)

    # Raw fields (anything we don't explicitly parse)
    raw_extras: dict = field(default_factory=dict)

    # Metadata
    fetched_at:  float = field(default_factory=time.time)

    def to_dict(self):
        d = asdict(self)
        d["fetched_at_iso"] = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.fetched_at)
        )
        return d

    @property
    def progress_percent(self) -> float:
        if self.layer.total_layers > 0:
            return round(self.layer.current_layer / self.layer.total_layers * 100, 2)
        return self.elapsed_percent


# ── Packet framing ─────────────────────────────────────────────────────────────

def _pack(payload: bytes) -> bytes:
    """Prepend 4-byte LE length header."""
    return struct.pack("<I", len(payload)) + payload

def _unpack(sock: socket.socket) -> Optional[bytes]:
    """Read one length-prefixed packet from `sock`. Returns raw payload bytes."""
    try:
        header = _recv_exact(sock, 4)
        if not header:
            return None
        length = struct.unpack("<I", header)[0]
        if length == 0 or length > 1_048_576:   # sanity: 0 B – 1 MB
            return None
        return _recv_exact(sock, length)
    except (OSError, struct.error):
        return None

def _recv_exact(sock: socket.socket, n: int) -> Optional[bytes]:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


# ── Known Chitu command IDs (reverse-engineered by community) ─────────────────

CMD_GET_STATUS    = {"Cmd": 0, "Data": {"Uid": 0}}    # current print status
CMD_GET_FILE_LIST = {"Cmd": 258, "Data": {"Uid": 0}}  # list files in USB/storage
CMD_GET_SYS_INFO  = {"Cmd": 64, "Data": {"Uid": 0}}   # machine/firmware info

# Some firmware uses string-keyed commands instead
CMD_STATUS_STR    = "M27"   # Marlin-style: report print progress
CMD_SYSINFO_STR   = "M115"  # report firmware info


# ── Parser ─────────────────────────────────────────────────────────────────────

def _parse_status(raw: dict) -> PrintStatus:
    """Map the raw JSON dict from the printer to a PrintStatus dataclass."""
    s = PrintStatus()

    # Top-level fields (firmware varies in casing)
    def g(key, *fallbacks, default=None):
        for k in (key, *fallbacks):
            if k in raw:
                return raw[k]
        return default

    s.machine_name     = g("MachineName", "Name", default="")
    s.machine_status   = g("Status", "PrintStatus", default="IDLE").upper()
    s.firmware_version = g("FirmwareVersion", "Firmware", default="")
    s.protocol_version = g("ProtocolVersion", default="")
    s.current_file     = g("Filename", "FileName", "PrintFile", default="")
    s.print_id         = str(g("PrintId", default=""))
    s.print_time_s     = int(g("PrintTime", "TotalPrintTime", default=0))
    s.remaining_time_s = int(g("RemainTime", "RemainingTime", default=0))
    s.elapsed_percent  = float(g("PrintPercent", "Progress", default=0))

    # Layer info
    s.layer.current_layer   = int(g("CurrentLayer", "Layer", default=0))
    s.layer.total_layers    = int(g("TotalLayer", "Layers", default=0))
    s.layer.layer_height_mm = float(g("LayerHeight", default=0.0))
    s.layer.z_position_mm   = float(g("CurrentPosition", "ZPosition", default=0.0))

    # Exposure
    s.exposure.exposure_time_s   = float(g("ExposureTime", default=0.0))
    s.exposure.bottom_layers     = int(g("BottomLayers", default=0))
    s.exposure.bottom_exposure_s = float(g("BottomExposureTime", default=0.0))
    s.exposure.uv_power_percent  = int(g("UVPower", "LightPWM", default=0))
    s.exposure.anti_alias_level  = int(g("AntiAliasLevel", default=0))

    # Temperature
    s.temperature.uvled_temp_c     = float(g("TempOfUVLED", "LEDTemp", default=0.0))
    s.temperature.enclosure_temp_c = float(g("TempOfBox", "BoxTemp", default=0.0))

    # Keep unknown keys for later inspection
    known = {
        "MachineName","Name","Status","PrintStatus","FirmwareVersion","Firmware",
        "ProtocolVersion","Filename","FileName","PrintFile","PrintId","PrintTime",
        "TotalPrintTime","RemainTime","RemainingTime","PrintPercent","Progress",
        "CurrentLayer","Layer","TotalLayer","Layers","LayerHeight","CurrentPosition",
        "ZPosition","ExposureTime","BottomLayers","BottomExposureTime","UVPower",
        "LightPWM","AntiAliasLevel","TempOfUVLED","LEDTemp","TempOfBox","BoxTemp",
    }
    s.raw_extras = {k: v for k, v in raw.items() if k not in known}
    s.fetched_at = time.time()
    return s


# ── TCP client ─────────────────────────────────────────────────────────────────

class ChituTCPClient:
    """
    Persistent TCP connection to the printer.

    Usage:
        with ChituTCPClient("192.168.1.42") as c:
            status = c.get_status()
            files  = c.get_file_list()
    """

    def __init__(self, ip: str, port: int = CHITU_TCP_PORT, timeout: float = 5.0):
        self.ip      = ip
        self.port    = port
        self.timeout = timeout
        self._sock: Optional[socket.socket] = None

    def connect(self):
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(self.timeout)
        self._sock.connect((self.ip, self.port))
        print(f"[TCP] Connected to {self.ip}:{self.port}")

    def disconnect(self):
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.disconnect()

    # ── Low-level send/recv ─────────────────────────────────────────────────

    def _send_json(self, cmd: dict) -> Optional[dict]:
        payload = json.dumps(cmd).encode("utf-8")
        self._sock.sendall(_pack(payload))
        raw = _unpack(self._sock)
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"_raw_hex": raw.hex()}

    def _send_gcode(self, cmd: str) -> Optional[str]:
        """Some firmware accepts Marlin G-code over the same TCP socket."""
        payload = (cmd + "\n").encode("utf-8")
        self._sock.sendall(_pack(payload))
        raw = _unpack(self._sock)
        return raw.decode("utf-8", errors="replace").strip() if raw else None

    # ── High-level commands ─────────────────────────────────────────────────

    def get_status(self) -> Optional[PrintStatus]:
        """Fetch current print status."""
        resp = self._send_json(CMD_GET_STATUS)
        if resp and "Data" in resp:
            return _parse_status(resp["Data"])
        if resp and "Cmd" not in resp:
            # Some firmware sends the status dict directly (no envelope)
            return _parse_status(resp)
        # Fallback: try Marlin-style
        raw_str = self._send_gcode(CMD_STATUS_STR)
        if raw_str:
            return _parse_marlin_m27(raw_str)
        return None

    def get_system_info(self) -> Optional[dict]:
        """Fetch machine/firmware info."""
        resp = self._send_json(CMD_GET_SYS_INFO)
        if resp:
            return resp.get("Data", resp)
        raw_str = self._send_gcode(CMD_SYSINFO_STR)
        return {"raw": raw_str} if raw_str else None

    def get_file_list(self) -> list[dict]:
        """List files available on the printer's USB/internal storage."""
        resp = self._send_json(CMD_GET_FILE_LIST)
        if resp and "Data" in resp:
            data = resp["Data"]
            # Could be a list or a dict with a list inside
            if isinstance(data, list):
                return data
            if isinstance(data, dict):
                for key in ("FileList", "Files", "file_list"):
                    if key in data:
                        return data[key]
        return []

    def raw_command(self, cmd_dict: dict) -> Optional[dict]:
        """Send an arbitrary JSON command. Use for exploration."""
        return self._send_json(cmd_dict)


# ── Marlin fallback parser ─────────────────────────────────────────────────────

def _parse_marlin_m27(text: str) -> PrintStatus:
    """
    Parse response to M27 (SD print status).
    Typical: 'SD printing byte 102400/204800'
    """
    s = PrintStatus()
    s.machine_status = "IDLE"
    if "printing" in text.lower():
        s.machine_status = "PRINTING"
        parts = text.split("/")
        try:
            current = int(parts[0].split()[-1])
            total   = int(parts[1].strip())
            s.elapsed_percent = round(current / total * 100, 2)
        except (ValueError, IndexError):
            pass
    return s


# ── Convenience one-shot function ─────────────────────────────────────────────

def fetch_status(ip: str, port: int = CHITU_TCP_PORT) -> Optional[PrintStatus]:
    """One-shot: connect, fetch status, disconnect."""
    try:
        with ChituTCPClient(ip, port) as c:
            return c.get_status()
    except (OSError, ConnectionRefusedError) as e:
        print(f"[TCP] Could not connect to {ip}:{port} — {e}")
        return None


# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    ip = sys.argv[1] if len(sys.argv) > 1 else None
    if not ip:
        print("Usage: python tcp_status.py <printer_ip>")
        print("Example: python tcp_status.py 192.168.1.42")
        sys.exit(1)

    print(f"[*] Connecting to {ip} ...")
    with ChituTCPClient(ip) as c:
        print("\n--- System info ---")
        info = c.get_system_info()
        print(json.dumps(info, indent=2))

        print("\n--- Print status ---")
        status = c.get_status()
        if status:
            print(json.dumps(status.to_dict(), indent=2))
        else:
            print("No status received")

        print("\n--- File list ---")
        files = c.get_file_list()
        for f in files:
            print(" ", f)