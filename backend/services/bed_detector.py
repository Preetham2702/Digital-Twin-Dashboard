# services/bed_detector.py
"""
Bed-occupancy detection for the FDM printer.

Region of interest — pick ONE:
  BED_POLY  = "x1,y1 x2,y2 x3,y3 ..."   polygon in fractions 0-1 (perspective-
              accurate — follows the real bed shape, can dodge the container).
              Takes precedence when set.
  BED_ROI   = "x,y,w,h"                 simple rectangle in fractions 0-1.
  (neither) = whole frame.

Detection modes (BED_MODE):
  reference  (default) — change detection vs a saved empty-bed image. Cancels
             static glare, handles dark prints. Needs POST /capture-empty-bed.
  brightness           — flags anything brighter than the dark bed inside the
             region. No reference, but fails if the bed has bright reflections.

Public interface (imported by FDM_Printer.py), identical in every mode:
    save_empty_bed()   -> dict
    check_bed_status() -> dict  { success, print_present, changed_pixels,
                                   area_frac, label, mode }
Both do blocking work — call via `await asyncio.to_thread(...)`.
"""

import os
import cv2
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

PRINTER_IP = os.getenv("FDM_PRINTER_IP", "")

BED_CAMERA_URL = os.getenv("BED_CAMERA_URL", f"http://{PRINTER_IP}:8080/?action=snapshot")
BED_STREAM_URL = os.getenv("BED_STREAM_URL", f"http://{PRINTER_IP}:8080/?action=stream")

REFERENCE_PATH = os.getenv("BED_REFERENCE_PATH", "images/empty_bed.jpg")

BED_MODE = os.getenv("BED_MODE", "reference").strip().lower()  # reference | brightness

# ---- region of interest -----------------------------------------------------
# Default polygon is the bed outline traced for this camera (fractions 0-1).
# Override with BED_POLY in .env if the camera is re-aimed.
_DEFAULT_POLY = ("0.054,0.748 0.192,0.671 0.392,0.629 0.545,0.577 "
                 "0.898,0.787 0.975,0.809 0.99,0.827 0.998,0.999 0.054,0.999")
BED_POLY = os.getenv("BED_POLY", _DEFAULT_POLY).strip()   # "x1,y1 x2,y2 ..." fractions 0-1
BED_ROI = os.getenv("BED_ROI", "").strip()     # "x,y,w,h" fractions 0-1 (fallback)

# ---- tuning knobs -----------------------------------------------------------
MIN_AREA_FRAC = float(os.getenv("BED_MIN_AREA_FRAC", "0.01"))
BED_BRIGHTNESS_THRESHOLD = int(os.getenv("BED_BRIGHTNESS_THRESHOLD", "100"))
DIFF_THRESHOLD = int(os.getenv("BED_DIFF_THRESHOLD", "40"))
# -----------------------------------------------------------------------------

_KERNEL = np.ones((5, 5), np.uint8)


def _grab_frame():
    """Fetch one frame from the printer camera as a BGR numpy image (or None)."""
    for url in (BED_CAMERA_URL, BED_STREAM_URL):
        try:
            if "action=stream" in url:
                cap = cv2.VideoCapture(url)
                ok, frame = cap.read()
                cap.release()
                if ok and frame is not None:
                    return frame
            else:
                resp = requests.get(url, timeout=5)
                if resp.ok and resp.content:
                    arr = np.frombuffer(resp.content, np.uint8)
                    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                    if frame is not None:
                        return frame
        except Exception:
            continue
    return None


def _parse_poly():
    if not BED_POLY:
        return None
    try:
        pts = []
        for tok in BED_POLY.split():
            x, y = tok.split(",")
            pts.append((float(x), float(y)))
        return pts if len(pts) >= 3 else None
    except Exception:
        return None


def _region_mask(h, w):
    """Binary mask (255 inside the region) for the given frame size.

    Priority: BED_POLY -> BED_ROI rectangle -> whole frame.
    """
    pts = _parse_poly()
    if pts:
        arr = np.array([[int(px * w), int(py * h)] for px, py in pts], np.int32)
        m = np.zeros((h, w), np.uint8)
        cv2.fillPoly(m, [arr], 255)
        return m

    if BED_ROI:
        try:
            fx, fy, fw, fh = (float(v) for v in BED_ROI.split(","))
            m = np.zeros((h, w), np.uint8)
            x0, y0 = int(fx * w), int(fy * h)
            x1, y1 = int((fx + fw) * w), int((fy + fh) * h)
            m[y0:y1, x0:x1] = 255
            return m
        except Exception:
            pass

    return np.full((h, w), 255, np.uint8)


def _largest_blob(mask, region_px):
    """(nonzero_pixels, largest_blob / region_px) after morphological cleanup."""
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _KERNEL)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, _KERNEL)
    nonzero = int(np.count_nonzero(mask))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    largest = max((cv2.contourArea(c) for c in contours), default=0.0)
    return nonzero, (largest / region_px if region_px else 0.0)


def _gray(img):
    return cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (7, 7), 0)


def _result(present, pixels, area_frac):
    label = "Print exists" if present else "Empty"
    tag = "🟠 " if present else ""
    print(f"[BED] {tag}{label} — area_frac={area_frac:.4f} "
          f"(threshold {MIN_AREA_FRAC}), px={pixels}, mode={BED_MODE}")
    return {
        "success": True,
        "print_present": present,
        "changed_pixels": pixels,
        "area_frac": round(area_frac, 4),
        "label": label,
        "mode": BED_MODE,
    }


# =========================================================================
# BRIGHTNESS MODE
# =========================================================================
def _check_brightness():
    frame = _grab_frame()
    if frame is None:
        print(f"[BED] ⚠️ could not read camera frame (tried {BED_CAMERA_URL} / {BED_STREAM_URL})")
        return {"success": False, "error": "Could not read camera frame", "print_present": False}

    gray = _gray(frame)
    region = _region_mask(*gray.shape)
    _, mask = cv2.threshold(gray, BED_BRIGHTNESS_THRESHOLD, 255, cv2.THRESH_BINARY)
    mask = cv2.bitwise_and(mask, region)
    pixels, area_frac = _largest_blob(mask, int(np.count_nonzero(region)))
    return _result(area_frac >= MIN_AREA_FRAC, pixels, area_frac)


# =========================================================================
# REFERENCE MODE
# =========================================================================
def _check_reference():
    if not os.path.exists(REFERENCE_PATH):
        print(f"[BED] ⚠️ no empty-bed reference at {REFERENCE_PATH} — run POST /capture-empty-bed first")
        return {"success": False, "error": "No empty-bed reference saved", "print_present": False}

    reference = cv2.imread(REFERENCE_PATH)
    if reference is None:
        print(f"[BED] ⚠️ reference image unreadable at {REFERENCE_PATH}")
        return {"success": False, "error": "Reference image unreadable", "print_present": False}

    frame = _grab_frame()
    if frame is None:
        print(f"[BED] ⚠️ could not read camera frame (tried {BED_CAMERA_URL} / {BED_STREAM_URL})")
        return {"success": False, "error": "Could not read camera frame", "print_present": False}

    ref = _gray(reference)
    cur = _gray(frame)
    if ref.shape != cur.shape:
        cur = cv2.resize(cur, (ref.shape[1], ref.shape[0]))

    region = _region_mask(*ref.shape)
    diff = cv2.absdiff(ref, cur)
    _, mask = cv2.threshold(diff, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY)
    mask = cv2.bitwise_and(mask, region)
    pixels, area_frac = _largest_blob(mask, int(np.count_nonzero(region)))
    return _result(area_frac >= MIN_AREA_FRAC, pixels, area_frac)


# =========================================================================
# PUBLIC INTERFACE
# =========================================================================
def save_empty_bed():
    """Capture the current frame as the empty-bed reference (reference mode)."""
    frame = _grab_frame()
    if frame is None:
        return {"success": False, "error": "Could not read camera frame"}
    os.makedirs(os.path.dirname(REFERENCE_PATH) or ".", exist_ok=True)
    cv2.imwrite(REFERENCE_PATH, frame)
    return {"success": True, "path": REFERENCE_PATH}


def check_bed_status():
    """Detect whether a print is on the bed, using the configured BED_MODE."""
    if BED_MODE == "brightness":
        return _check_brightness()
    return _check_reference()