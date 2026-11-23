#!/usr/bin/env python3
"""Draws the OutboundXray icons (no dependencies): on an indigo-to-violet
rounded square, white lines run from a centre dot (the page) out to four
rings (the companies it sends to), forming the X of the name.

The 128 px icon keeps the Web Store's 16 px transparent margin (96 px of
artwork); the toolbar sizes fill their square so they stay readable.
Run: python3 scripts/make-icons.py  (or npm run icons)"""
import math
import os
import struct
import zlib
from functools import partial

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
SS = 8  # supersampling factor for anti-aliasing

GRADIENT = ((79, 70, 229), (147, 51, 234))  # indigo -> violet, top-left to bottom-right
LINE = (255, 255, 255)
CORE = (253, 230, 138)

# Geometry in unit coordinates (0..1), drawn on a 128-unit grid.
U = 1 / 128
CORNER_RADIUS = 28 * U
CENTRE = (0.5, 0.5)
ENDS = [(31 * U, 31 * U), (97 * U, 31 * U), (31 * U, 97 * U), (97 * U, 97 * U)]
LINE_HALF_WIDTH = 5.5 * U
SMALL_LINE_SCALE = 1.4  # thicker lines at 16 px
RING_RADIUS, RING_HALF_WIDTH = 11 * U, 3.5 * U
CORE_RADIUS = 15 * U


def background(x, y):
    t = (x + y) / 2
    return tuple(round(a + (b - a) * t) for a, b in zip(*GRADIENT))


def segment_distance(x, y, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)


def shade(x, y, small=False):
    """Colour (r, g, b, a) of the full-bleed icon at unit coordinates 0..1.
    `small` (16 px): solid dots and thicker lines, as hollow rings blur at that size."""
    cx = min(max(x, CORNER_RADIUS), 1 - CORNER_RADIUS)
    cy = min(max(y, CORNER_RADIUS), 1 - CORNER_RADIUS)
    if (x - cx) ** 2 + (y - cy) ** 2 > CORNER_RADIUS ** 2:
        return (0, 0, 0, 0)
    if math.hypot(x - CENTRE[0], y - CENTRE[1]) <= CORE_RADIUS:
        return (*CORE, 255)
    for end in ENDS:
        d = math.hypot(x - end[0], y - end[1])
        if abs(d - RING_RADIUS) <= RING_HALF_WIDTH or (small and d < RING_RADIUS):
            return (*LINE, 255)
        if d < RING_RADIUS:
            return (*background(x, y), 255)  # the ring's hollow middle
    half_width = LINE_HALF_WIDTH * (SMALL_LINE_SCALE if small else 1)
    if any(segment_distance(x, y, CENTRE, end) <= half_width for end in ENDS):
        return (*LINE, 255)
    return (*background(x, y), 255)


def padded(margin):
    """The icon shrunk inside a transparent margin (a fraction of the side)."""
    scale = 1 - 2 * margin

    def at(x, y):
        u, v = (x - margin) / scale, (y - margin) / scale
        return shade(u, v) if 0 <= u <= 1 and 0 <= v <= 1 else (0, 0, 0, 0)

    return at


def render(size, draw):
    rows = []
    n = SS * SS
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = draw((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            if acc[3]:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(acc[3] / n)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for size, draw in ((16, partial(shade, small=True)), (32, shade), (48, shade), (128, padded(16 / 128))):
        with open(os.path.join(OUT, f"icon{size}.png"), "wb") as f:
            f.write(png(size, render(size, draw)))
    print("icons written to", os.path.abspath(OUT))
