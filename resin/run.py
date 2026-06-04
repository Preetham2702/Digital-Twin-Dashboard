"""
Elegoo Saturn 4 Ultra — Main runner
Combines discovery + TCP + HTTP into a single dump.

Usage:
    python run.py                    # auto-discover printer on LAN
    python run.py 192.168.1.42       # target a known IP
    python run.py 192.168.1.42 --watch  # poll every 5s (live monitor)
"""

import json
import sys
import time
from discover       import discover_printers, probe_ip
from tcp_status     import ChituTCPClient, fetch_status
from http_extractor import ChituHTTPClient


def full_snapshot(ip: str) -> dict:
    """Collect everything from both TCP and HTTP layers."""
    result = {
        "ip":         ip,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tcp":  {},
        "http": {},
    }

    # ── TCP ──────────────────────────────────────────────────────────────────
    try:
        with ChituTCPClient(ip, timeout=5) as tcp:
            status   = tcp.get_status()
            sysinfo  = tcp.get_system_info()
            files    = tcp.get_file_list()
            result["tcp"] = {
                "status":   status.to_dict() if status else None,
                "sysinfo":  sysinfo,
                "files":    files,
            }
    except Exception as e:
        result["tcp"]["error"] = str(e)

    # ── HTTP ─────────────────────────────────────────────────────────────────
    try:
        http = ChituHTTPClient(ip)
        result["http"] = {
            "status":       http.get_status(),
            "machine_info": http.get_machine_info(),
            "files":        http.get_file_list(),
        }
    except Exception as e:
        result["http"]["error"] = str(e)

    return result


def print_summary(snap: dict):
    tcp_status = snap.get("tcp", {}).get("status") or {}
    http_status = snap.get("http", {}).get("status") or {}
    status = tcp_status or http_status

    # Pick values from whichever layer answered
    def pick(*keys):
        for k in keys:
            v = status.get(k)
            if v is not None:
                return v
        return "—"

    machine = pick("machine_name")
    state   = pick("machine_status", "Status")
    file_   = pick("current_file", "Filename")
    layer   = status.get("layer") or {}
    cur_l   = layer.get("current_layer", "—") if isinstance(layer, dict) else "—"
    tot_l   = layer.get("total_layers", "—") if isinstance(layer, dict) else "—"
    pct     = pick("elapsed_percent", "PrintPercent")
    remain  = pick("remaining_time_s", "RemainTime")

    bar_w = 30
    try:
        filled = int(float(pct) / 100 * bar_w)
        bar    = "█" * filled + "░" * (bar_w - filled)
        pct_str = f"{float(pct):.1f}%"
    except (TypeError, ValueError):
        bar, pct_str = "░" * bar_w, "—"

    print(f"\n╔══ {machine}  [{state}]  {snap['fetched_at']}")
    print(f"║  File    : {file_}")
    print(f"║  Layer   : {cur_l} / {tot_l}")
    print(f"║  Progress: [{bar}] {pct_str}")
    if remain and remain != "—":
        m, s = divmod(int(remain), 60)
        h, m = divmod(m, 60)
        print(f"║  Remain  : {h:02d}:{m:02d}:{s:02d}")
    print("╚" + "═" * 54)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ip    = None
    watch = "--watch" in sys.argv
    args  = [a for a in sys.argv[1:] if not a.startswith("--")]

    if args:
        ip = args[0]
        print(f"[*] Using provided IP: {ip}")
    else:
        print("[*] Discovering printer on LAN (10 s) ...")
        printers = discover_printers(timeout=10)
        if not printers:
            print("[!] No printer found. Provide IP as argument: python run.py <ip>")
            sys.exit(1)
        if len(printers) > 1:
            print("[*] Multiple printers found:")
            for i, p in enumerate(printers):
                print(f"  [{i}] {p.ip}  {p.machine_name}")
            idx = int(input("Select index: ") or "0")
            ip = printers[idx].ip
        else:
            ip = printers[0].ip
            print(f"[*] Found: {ip}  {printers[0].machine_name}")

    if watch:
        interval = 5
        print(f"\n[*] Watching {ip} every {interval}s — Ctrl-C to stop\n")
        while True:
            try:
                snap = full_snapshot(ip)
                print_summary(snap)
                time.sleep(interval)
            except KeyboardInterrupt:
                print("\n[*] Stopped.")
                break
    else:
        snap = full_snapshot(ip)
        print_summary(snap)
        out_file = f"snapshot_{ip.replace('.','_')}.json"
        with open(out_file, "w") as f:
            json.dump(snap, f, indent=2, default=str)
        print(f"\n[*] Full snapshot saved to {out_file}")


if __name__ == "__main__":
    main()