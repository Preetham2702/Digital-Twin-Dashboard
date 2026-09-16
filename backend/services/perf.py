"""
Performance logging for the digital-twin backend.

Every timed operation is written as one row to logs/perf.csv (and echoed to the
console). Two kinds of timings are recorded:

  kind="api"       – a dashboard request handled by FastAPI (frontend -> backend)
  kind="upstream"  – a call from the backend to the physical printer
                     (Moonraker HTTP for FDM, TCP control socket for PocketNC,
                     SDCP websocket / HTTP upload for the resin printer)

CSV columns: timestamp, printer, kind, method, path, status, duration_s (seconds), error
"""
import csv
import os
import threading
import time
import logging
import statistics
from collections import deque
from contextlib import contextmanager

import httpx

LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
CSV_PATH = os.path.join(LOG_DIR, "perf.csv")
FIELDS = ["timestamp", "printer", "kind", "method", "path", "status", "duration_s", "error"]

# set PERF_CONSOLE=0 in .env / environment to silence the console echo
CONSOLE = os.getenv("PERF_CONSOLE", "1") != "0"

_lock = threading.Lock()
_recent = deque(maxlen=5000)   # in-memory ring for /perf/stats
log = logging.getLogger("perf")


def _ensure_file():
    os.makedirs(LOG_DIR, exist_ok=True)
    if not os.path.exists(CSV_PATH) or os.path.getsize(CSV_PATH) == 0:
        with open(CSV_PATH, "w", newline="") as f:
            csv.writer(f).writerow(FIELDS)


def record(printer: str, kind: str, method: str, path: str, status, duration_s: float, error: str = ""):
    """Append one timing row (duration in seconds). Safe to call from any thread."""
    row = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S") + f".{int((time.time() % 1) * 1000):03d}",
        "printer": printer,
        "kind": kind,
        "method": method,
        "path": path,
        "status": status if status is not None else "",
        "duration_s": round(duration_s, 4),
        "error": (error or "")[:120],
    }
    with _lock:
        try:
            _ensure_file()
            with open(CSV_PATH, "a", newline="") as f:
                csv.DictWriter(f, fieldnames=FIELDS).writerow(row)
        except Exception as e:      # logging must never break the app
            print("[PERF] write failed:", e)
        _recent.append(row)

    if CONSOLE:
        flag = "❌" if error else "⏱ "
        print(f"{flag} [PERF] {printer:<8} {kind:<8} {method:<6} {path:<40} {str(row['status']):<4} {row['duration_s']:>9} s")


def printer_for_path(path: str) -> str:
    """Map a backend route to the printer it belongs to."""
    if path.startswith("/pocketnc") or path == "/ws/pocketnc":
        return "pocketnc"
    if path in ("/ws/resin", "/preview"):
        return "resin"
    if path.startswith("/perf") or path == "/":
        return "system"
    return "fdm"


@contextmanager
def span(printer: str, kind: str, method: str, path: str):
    """
    Time a block of code (sync). Usage:

        with span("pocketnc", "upstream", "TCP", "start") as s:
            ...
            s["status"] = 200
    """
    info = {"status": None, "error": ""}
    t0 = time.perf_counter()
    try:
        yield info
    except Exception as e:
        info["error"] = repr(e)
        raise
    finally:
        record(printer, kind, method, path, info["status"], time.perf_counter() - t0, info["error"])


class _TimedAsyncClient(httpx.AsyncClient):
    """httpx.AsyncClient that logs every request's round-trip, including failures
    (timeouts / connection errors), tagged with a printer name."""

    def __init__(self, printer: str, **kwargs):
        super().__init__(**kwargs)
        self._perf_printer = printer

    async def send(self, request, *args, **kwargs):
        t0 = time.perf_counter()
        try:
            response = await super().send(request, *args, **kwargs)
        except Exception as e:
            record(self._perf_printer, "upstream", request.method, request.url.path,
                   None, time.perf_counter() - t0, repr(e))
            raise
        record(self._perf_printer, "upstream", request.method, request.url.path,
               response.status_code, time.perf_counter() - t0)
        return response


def timed_client(printer: str, **kwargs) -> httpx.AsyncClient:
    """
    Drop-in replacement for httpx.AsyncClient(...) that logs the round-trip time
    of every request it makes (successes and failures), tagged with the printer.
    """
    return _TimedAsyncClient(printer, **kwargs)


def stats():
    """Aggregate the in-memory ring: count / avg / p50 / p95 / max per printer+kind+path."""
    with _lock:
        rows = list(_recent)
    groups = {}
    for r in rows:
        key = (r["printer"], r["kind"], r["method"], r["path"])
        groups.setdefault(key, []).append(float(r["duration_s"]))
    out = []
    for (printer, kind, method, path), d in sorted(groups.items()):
        d.sort()
        out.append({
            "printer": printer, "kind": kind, "method": method, "path": path,
            "count": len(d),
            "avg_s": round(sum(d) / len(d), 4),
            "p50_s": round(statistics.median(d), 4),
            "p95_s": round(d[min(len(d) - 1, int(len(d) * 0.95))], 4),
            "max_s": round(d[-1], 4),
        })
    return out
