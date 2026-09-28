"""Rasterize icons/icon.svg's shapes to PNG without dependencies (full-bleed square for maskable/iOS)."""
import struct, zlib, os

BG = (0x1a, 0x1a, 0x19)
BARS = [(128, 236, 192, 388, (0x39, 0x87, 0xe5)), (224, 156, 288, 388, (0xeb, 0x68, 0x34)), (320, 196, 384, 388, (0x1b, 0xaf, 0x7a))]
R, SS = 16, 4

def inside(x, y, x0, y0, x1, y1):
    if not (x0 <= x < x1 and y0 <= y < y1): return False
    cx = min(max(x, x0 + R), x1 - R); cy = min(max(y, y0 + R), y1 - R)
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R

def render(size):
    rows = []
    s = 512 / size
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    x, y = (px + (sx + .5) / SS) * s, (py + (sy + .5) / SS) * s
                    col = BG
                    for x0, y0, x1, y1, c in BARS:
                        if inside(x, y, x0, y0, x1, y1): col = c; break
                    for i in range(3): acc[i] += col[i]
            row += bytes(a // (SS * SS) for a in acc)
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(__file__), '..', 'icons')
for name, size in [('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180)]:
    open(os.path.join(out, name), 'wb').write(render(size))
    print(name)
