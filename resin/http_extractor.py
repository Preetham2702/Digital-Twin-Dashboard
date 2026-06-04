"""
Elegoo Saturn 4 Ultra — Step 3: HTTP Endpoint Extraction
The Saturn 4 Ultra runs a lightweight HTTP server on port 80.
We probe all known endpoints and return whatever each one gives us.

Known endpoints (discovered via Wireshark + community reverse engineering):
  GET /status           → JSON print status (same schema as TCP)
  GET /files            → JSON file list
  GET /thumbnail?file=X → PNG thumbnail of a .ctb file
  GET /info             → machine info / firmware
  GET /api/version      → protocol / API version
  POST /ctrl            → send control commands (pause, stop, etc.)
  GET /download?file=X  → download a file (careful — large)
"""

import json
import time
import urllib.request
import urllib.parse
import urllib.error
from dataclasses import dataclass, field, asdict
from typing import Optional, Any

HTTP_PORT    = 80
HTTP_TIMEOUT = 5.0

KNOWN_ENDPOINTS = [
    "/status",
    "/files",
    "/info",
    "/api/version",
    "/api/status",
    "/api/files",
    "/api/machine",
    "/printer/status",
    "/m/status",
]


# ── Probe all endpoints ────────────────────────────────────────────────────────

def probe_all_endpoints(ip: str, port: int = HTTP_PORT) -> dict[str, Any]:
    """
    Hit every known endpoint and return a dict of
    {endpoint: parsed_json_or_raw_text_or_error_string}.
    Useful for initial exploration of a specific firmware version.
    """
    base = f"http://{ip}:{port}"
    results = {}
    for ep in KNOWN_ENDPOINTS:
        url = base + ep
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Saturn4Extractor/1.0"})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read()
                ct  = resp.getheader("Content-Type", "")
                if "json" in ct or raw.startswith(b"{") or raw.startswith(b"["):
                    results[ep] = json.loads(raw)
                else:
                    results[ep] = raw.decode("utf-8", errors="replace")
                print(f"  [HTTP {resp.status}] {ep}")
        except urllib.error.HTTPError as e:
            results[ep] = f"HTTP {e.code}: {e.reason}"
        except urllib.error.URLError as e:
            results[ep] = f"URLError: {e.reason}"
        except Exception as e:
            results[ep] = f"Error: {e}"
    return results


# ── Targeted extractors ────────────────────────────────────────────────────────

class ChituHTTPClient:
    """
    Simple HTTP client for the printer's REST endpoints.
    No third-party dependencies — uses only stdlib urllib.
    """

    def __init__(self, ip: str, port: int = HTTP_PORT, timeout: float = HTTP_TIMEOUT):
        self.base    = f"http://{ip}:{port}"
        self.timeout = timeout

    def _get_json(self, path: str) -> Optional[dict | list]:
        url = self.base + path
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Saturn4Extractor/1.0"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, json.JSONDecodeError, OSError):
            return None

    def _get_bytes(self, path: str) -> Optional[bytes]:
        url = self.base + path
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Saturn4Extractor/1.0"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, OSError):
            return None

    def _post_json(self, path: str, data: dict) -> Optional[dict]:
        url     = self.base + path
        payload = json.dumps(data).encode("utf-8")
        try:
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Saturn4Extractor/1.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, json.JSONDecodeError, OSError):
            return None

    # ── Data endpoints ──────────────────────────────────────────────────────

    def get_status(self) -> Optional[dict]:
        """
        Try /status then /api/status — return whichever works.
        Keys depend on firmware; the data mirrors the TCP status payload.
        """
        for path in ("/status", "/api/status", "/printer/status", "/m/status"):
            result = self._get_json(path)
            if result:
                return result
        return None

    def get_machine_info(self) -> Optional[dict]:
        for path in ("/info", "/api/machine", "/api/version"):
            result = self._get_json(path)
            if result:
                return result
        return None

    def get_file_list(self) -> list[dict]:
        for path in ("/files", "/api/files"):
            result = self._get_json(path)
            if isinstance(result, list):
                return result
            if isinstance(result, dict):
                for key in ("files", "Files", "FileList", "data"):
                    if key in result and isinstance(result[key], list):
                        return result[key]
        return []

    def get_thumbnail(self, filename: str) -> Optional[bytes]:
        """
        Fetch the preview PNG embedded in a .ctb file.
        `filename` is the name as returned by get_file_list().
        """
        encoded = urllib.parse.quote(filename)
        for path in (f"/thumbnail?file={encoded}", f"/api/thumbnail?file={encoded}"):
            data = self._get_bytes(path)
            if data and data[:4] in (b"\x89PNG", b"\xff\xd8\xff", b"GIF8"):
                return data
        return None

    def get_full_snapshot(self) -> dict:
        """
        Fetch all available data in one call. Returns a dict with keys:
        'status', 'machine_info', 'files', 'fetched_at'.
        """
        return {
            "status":       self.get_status(),
            "machine_info": self.get_machine_info(),
            "files":        self.get_file_list(),
            "fetched_at":   time.time(),
        }

    # ── Control commands (read-only for now — you asked for extraction) ─────

    def send_pause(self) -> Optional[dict]:
        """Pause an active print."""
        return self._post_json("/ctrl", {"Cmd": 1})   # Cmd 1 = PAUSE

    def send_resume(self) -> Optional[dict]:
        return self._post_json("/ctrl", {"Cmd": 2})   # Cmd 2 = RESUME

    def send_stop(self) -> Optional[dict]:
        return self._post_json("/ctrl", {"Cmd": 3})   # Cmd 3 = STOP


# ── Pretty printer for exploration ────────────────────────────────────────────

def dump_snapshot(ip: str, port: int = HTTP_PORT):
    print(f"\n[HTTP] Probing {ip}:{port} ...\n")
    client = ChituHTTPClient(ip, port)
    snap   = client.get_full_snapshot()

    print("=== Machine info ===")
    print(json.dumps(snap["machine_info"], indent=2))

    print("\n=== Print status ===")
    print(json.dumps(snap["status"], indent=2))

    print("\n=== File list ===")
    for f in snap["files"]:
        print(" ", f)

    print(f"\n[fetched_at: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(snap['fetched_at']))}]")
    return snap


# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    ip = sys.argv[1] if len(sys.argv) > 1 else None
    if not ip:
        print("Usage: python http_extractor.py <printer_ip> [--probe-all]")
        print("Example: python http_extractor.py 192.168.1.42")
        sys.exit(1)

    if "--probe-all" in sys.argv:
        print(f"[*] Probing ALL known endpoints on {ip} ...")
        results = probe_all_endpoints(ip)
        print(json.dumps(results, indent=2, default=str))
    else:
        dump_snapshot(ip)