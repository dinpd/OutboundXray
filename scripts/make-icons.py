#!/usr/bin/env python3
"""Draws the OutboundXray toolbar icons (no dependencies): a dark rounded square
with a cyan "scan" lens and a sweep line. Run: python3 scripts/make-icons.py"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
BG = (15, 23, 42)
CYAN = (34, 211, 238)
WHITE = (236, 254, 255)
SS = 4  # supersampling factor for anti-aliasing


def shade(x, y):
    """Colour (r, g, b, a) at unit coordinates 0..1."""
    # Rounded-square background.
    r = 0.22
    cx, cy = min(max(x, r), 1 - r), min(max(y, r), 1 - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return (0, 0, 0, 0)
    d = math.hypot(x - 0.5, y - 0.5)
    # Lens ring.
    if 0.25 <= d <= 0.33:
        return (*CYAN, 255)
    # Pupil.
    if d <= 0.11:
        return (*WHITE, 255)
    # Horizontal scan line through the lens.
    if abs(y - 0.5) <= 0.03 and 0.12 <= x <= 0.88:
        return (*CYAN, 255)
    return (*BG, 255)


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    a = c[3]
                    acc[0] += c[0] * a
                    acc[1] += c[1] * a
                    acc[2] += c[2] * a
                    acc[3] += a
            n = SS * SS
            alpha = acc[3] / n
            if acc[3]:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)])
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
    for s in (16, 32, 48, 128):
        with open(os.path.join(OUT, f"icon{s}.png"), "wb") as f:
            f.write(png(s, render(s)))
    print("icons written to", os.path.abspath(OUT))
