"""
Elegoo .goo header parser (Saturn 4 Ultra / Mars 5 etc.) — no third-party deps.

Layout (big-endian, per the GOO V3 spec / UVtools GooFile):
  0    Version(4) "V3.0" | Magic(8) 07 00 00 00 44 4C 50 00
  12   SoftwareInfo(32) SoftwareVersion(24) FileCreateTime(24)
       MachineName(32) MachineType(32) ProfileName(32)
  188  AntiAliasing u16, GreyLevel u16, BlurLevel u16
  194  SmallPreview 116x116 RGB565  + 0x0D0A
  27108 BigPreview  290x290 RGB565  + 0x0D0A
  195310 LayerCount ... (print settings, see _SETTINGS)
"""
import struct
import zlib

HEADER_BYTES = 196_000          # enough to cover previews + settings

_SMALL = (116, 116, 194)
_BIG = (290, 290, 27_108)
_SETTINGS_OFF = 195_310
_SETTINGS = struct.Struct(">I HH ?? 5f ? 8f I 16f HH ? I 3f 8s")
_TAIL = struct.Struct(">I B H")          # LayersDefinitionAddress, GreyScaleLevel, TransitionLayers
_SETTINGS_NAMES = (
    "layer_count", "res_x", "res_y", "mirror_x", "mirror_y",
    "display_w_mm", "display_h_mm", "machine_z_mm", "layer_height_mm", "exposure_s",
    "delay_mode", "light_off_delay_s",
    "bottom_wait_after_cure", "bottom_wait_after_lift", "bottom_wait_before_cure",
    "wait_after_cure", "wait_after_lift", "wait_before_cure", "bottom_exposure_s",
    "bottom_layers",
    "bottom_lift_mm", "bottom_lift_speed", "lift_mm", "lift_speed",
    "bottom_retract_mm", "bottom_retract_speed", "retract_mm", "retract_speed",
    "bottom_lift2_mm", "bottom_lift2_speed", "lift2_mm", "lift2_speed",
    "bottom_retract2_mm", "bottom_retract2_speed", "retract2_mm", "retract2_speed",
    "bottom_pwm", "pwm", "per_layer_settings",
    "print_time_s", "volume_mm3", "material_g", "material_cost", "currency",
)


def _s(b: bytes) -> str:
    return b.split(b"\0", 1)[0].decode("utf-8", "replace").strip()


def parse_goo_header(data: bytes) -> dict | None:
    """Return a dict of file details, or None if this isn't a recognisable .goo."""
    if len(data) < _SETTINGS_OFF + _SETTINGS.size:
        return None
    if data[4:12] != b"\x07\x00\x00\x00DLP\x00":
        return None
    # previews must be followed by CR LF — cheap layout sanity check
    if data[_BIG[2] - 2:_BIG[2]] != b"\r\n" or data[_SETTINGS_OFF - 2:_SETTINGS_OFF] != b"\r\n":
        return None

    v = dict(zip(_SETTINGS_NAMES, _SETTINGS.unpack_from(data, _SETTINGS_OFF)))
    if not (0.001 <= v["layer_height_mm"] <= 0.5 and 0 < v["layer_count"] < 200_000):
        return None

    layer_addr = _SETTINGS_OFF + _SETTINGS.size + _TAIL.size
    if len(data) >= _SETTINGS_OFF + _SETTINGS.size + _TAIL.size:
        a = _TAIL.unpack_from(data, _SETTINGS_OFF + _SETTINGS.size)[0]
        if 195_000 < a < 400_000:
            layer_addr = a

    return {
        "layer_def_addr": layer_addr,
        "res_x": v["res_x"],
        "res_y": v["res_y"],
        "display_w_mm": round(v["display_w_mm"], 2),
        "display_h_mm": round(v["display_h_mm"], 2),
        "version": _s(data[0:4]),
        "slicer": f"{_s(data[12:44])} {_s(data[44:68])}".strip(),
        "created": _s(data[68:92]),
        "machine": _s(data[92:124]),
        "layer_count": v["layer_count"],
        "layer_height_mm": round(v["layer_height_mm"], 4),
        "height_mm": round(v["layer_count"] * v["layer_height_mm"], 2),
        "resolution": f'{v["res_x"]}x{v["res_y"]}',
        "exposure_s": round(v["exposure_s"], 2),
        "bottom_exposure_s": round(v["bottom_exposure_s"], 2),
        "bottom_layers": v["bottom_layers"],
        "lift_mm": round(v["lift_mm"], 2),
        "lift_speed": round(v["lift_speed"], 1),
        "print_time_s": v["print_time_s"],
        "volume_ml": round(v["volume_mm3"] / 1000, 2),
        "material_g": round(v["material_g"], 2),
        "material_cost": round(v["material_cost"], 2),
        "currency": _s(v["currency"]),
    }


def goo_preview_png(data: bytes, big: bool = True) -> bytes | None:
    """Decode the embedded RGB565 preview into a PNG (pure python)."""
    w, h, off = _BIG if big else _SMALL
    n = w * h * 2
    if len(data) < off + n:
        return None
    px = data[off:off + n]
    rows = bytearray()
    for y in range(h):
        rows.append(0)                                   # PNG filter: none
        base = y * w * 2
        for x in range(w):
            c = (px[base + 2 * x] << 8) | px[base + 2 * x + 1]
            r, g, b = (c >> 11) & 0x1F, (c >> 5) & 0x3F, c & 0x1F
            rows += bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)))

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))


# ───────────────────────── layer data ─────────────────────────
# Each layer: LayerDef (70 bytes) + RLE image (DataLength bytes) + 0x0D0A
#   >H  pause | 15f pause_z, z, exposure, light_off, wait_after_cure, wait_after_lift,
#   wait_before_cure, lift_h, lift_s, lift_h2, lift_s2, retract_h, retract_s,
#   retract_h2, retract_s2 | H pwm | 2s 0x0D0A | I data_length
_LAYER = struct.Struct(">H 15f H 2s I")


def index_layers(f, start: int, count: int) -> list[tuple[int, int, float]] | None:
    """Walk the layer table of an open .goo file -> [(rle_offset, rle_len, z_mm)]."""
    out = []
    pos = start
    for _ in range(count):
        f.seek(pos)
        hdr = f.read(_LAYER.size)
        if len(hdr) < _LAYER.size:
            return None
        v = _LAYER.unpack(hdr)
        if v[17] != b"\r\n":
            return None
        length = v[18]
        out.append((pos + _LAYER.size, length, round(v[2], 3)))
        pos += _LAYER.size + length + 2
    return out


def decode_layer_grid(rle: bytes, res_x: int, res_y: int, out_w: int = 720,
                      aspect: float | None = None) -> tuple[bytearray, int, int, bool]:
    """Decode a GOO RLE layer into a downsampled greyscale grid (max-pooled, so
    features thinner than one output pixel survive). aspect = physical h/w of the
    screen (16K panels have non-square pixels). Returns (grid, w, h, ok)."""
    s = max(1, -(-res_x // out_w))
    ow = -(-res_x // s)
    oh = max(1, round(ow * aspect)) if aspect else -(-res_y // s)
    grid = bytearray(ow * oh)
    total = res_x * res_y
    pos = 0
    prev = 0
    i = 1                                   # rle[0] = 0x55 magic
    n = len(rle) - 1                        # last byte = checksum
    while i < n and pos < total:
        b = rle[i]
        t, lt, low = b >> 6, (b >> 4) & 3, b & 0xF
        if t == 2:                          # diff from previous grey
            if lt & 1:
                i += 1
                stride = rle[i]
            else:
                stride = 1
            grey = prev + low if lt < 2 else prev - low
        else:
            if t == 0:
                grey = 0
            elif t == 3:
                grey = 255
            else:
                i += 1
                grey = rle[i]
            # run length: extra bytes (big-endian) are the HIGH part, the
            # header's low nibble is the LOW 4 bits  (verified on real S4U files)
            if lt == 0:
                stride = low
            elif lt == 1:
                stride = (rle[i + 1] << 4) | low; i += 1
            elif lt == 2:
                stride = (((rle[i + 1] << 8) | rle[i + 2]) << 4) | low; i += 2
            else:
                stride = (((rle[i + 1] << 16) | (rle[i + 2] << 8) | rle[i + 3]) << 4) | low; i += 3
        i += 1
        prev = grey
        if grey and stride:
            end = min(pos + stride, total)
            p = pos
            y = p // res_x
            while p < end:
                row0 = y * res_x
                seg_end = min(end, row0 + res_x)
                a = (p - row0) // s
                bb = (seg_end - 1 - row0) // s
                base = (y * oh // res_y) * ow
                grid[base + a: base + bb + 1] = bytes((grey,)) * (bb - a + 1)
                p = seg_end
                y += 1
        pos += stride
    return grid, ow, oh, pos == total


def render_layer_png(rle: bytes, res_x: int, res_y: int, out_w: int = 720,
                     aspect: float | None = None) -> tuple[bytes, bool]:
    grid, ow, oh, ok = decode_layer_grid(rle, res_x, res_y, out_w, aspect)
    return _png_grey(grid, ow, oh), ok


# ───────────────────────── unsupported islands ─────────────────────────
try:
    import numpy as _np
    import cv2 as _cv2
except Exception:                                   # pragma: no cover
    _np = _cv2 = None


def find_unsupported_islands(grid: bytearray, prev: bytearray | None, w: int, h: int,
                             min_cells: int = 1) -> list[dict]:
    """Shapes in this layer that touch nothing cured in the layer below
    (1-cell tolerance). Returns [{x, y, cells}] with x/y normalised 0..1."""
    if prev is None:
        return []
    if _np is not None:
        cur = (_np.frombuffer(bytes(grid), dtype=_np.uint8).reshape(h, w) > 0).astype(_np.uint8)
        if not cur.any():
            return []
        below = (_np.frombuffer(bytes(prev), dtype=_np.uint8).reshape(h, w) > 0).astype(_np.uint8)
        below = _cv2.dilate(below, _np.ones((3, 3), _np.uint8))
        n, labels, stats, cents = _cv2.connectedComponentsWithStats(cur, connectivity=8)
        touched = _np.bincount(labels[below > 0].ravel(), minlength=n)
        out = []
        for k in range(1, n):
            if touched[k] == 0 and stats[k, _cv2.CC_STAT_AREA] >= min_cells:
                out.append({"x": round(float(cents[k][0]) / w, 4), "y": round(float(cents[k][1]) / h, 4),
                            "cells": int(stats[k, _cv2.CC_STAT_AREA])})
        return out
    # pure-python fallback (slower)
    seen = bytearray(w * h)
    out = []
    for start in range(w * h):
        if not grid[start] or seen[start]:
            continue
        stack, cells, sx, sy, supported = [start], 0, 0, 0, False
        seen[start] = 1
        while stack:
            c = stack.pop()
            cells += 1
            cy, cx = divmod(c, w)
            sx += cx; sy += cy
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w:
                        q = ny * w + nx
                        if prev[q]:
                            supported = True
                        if grid[q] and not seen[q]:
                            seen[q] = 1
                            stack.append(q)
        if not supported and cells >= min_cells:
            out.append({"x": round(sx / cells / w, 4), "y": round(sy / cells / h, 4), "cells": cells})
    return out


def _png_grey(px: bytearray, w: int, h: int) -> bytes:
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        rows += px[y * w:(y + 1) * w]

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))


# ───────────────────────── per-layer settings + cured area ─────────────────────────
_LAYER_NAMES = ("pause", "pause_z", "z", "exposure", "light_off", "wait_after_cure",
                "wait_after_lift", "wait_before_cure", "lift", "lift_speed", "lift2",
                "lift2_speed", "retract", "retract_speed", "retract2", "retract2_speed", "pwm")


def read_layer_settings(f, rle_offset: int) -> dict:
    """Layer definition sits right before the RLE data."""
    f.seek(rle_offset - _LAYER.size)
    v = _LAYER.unpack(f.read(_LAYER.size))
    return dict(zip(_LAYER_NAMES, v[:17]))


def layer_cured_pixels(rle: bytes, total: int) -> tuple[float, bool]:
    """Sum of cured pixels in a layer (grey-weighted: 255 = 1 full pixel)."""
    pos = 0
    prev = 0
    acc = 0                                 # sum of grey * run length
    i = 1
    n = len(rle) - 1
    while i < n:
        b = rle[i]
        t, lt, low = b >> 6, (b >> 4) & 3, b & 0xF
        if t == 2:
            if lt & 1:
                i += 1
                stride = rle[i]
            else:
                stride = 1
            grey = prev + low if lt < 2 else prev - low
        else:
            if t == 0:
                grey = 0
            elif t == 3:
                grey = 255
            else:
                i += 1
                grey = rle[i]
            if lt == 0:
                stride = low
            elif lt == 1:
                stride = (rle[i + 1] << 4) | low; i += 1
            elif lt == 2:
                stride = (((rle[i + 1] << 8) | rle[i + 2]) << 4) | low; i += 2
            else:
                stride = (((rle[i + 1] << 16) | (rle[i + 2] << 8) | rle[i + 3]) << 4) | low; i += 3
        i += 1
        prev = grey
        if grey:
            acc += grey * stride
        pos += stride
    return acc / 255.0, pos == total
