"""Draw the Ironbyte icon: a pixel weight plate with a bite out of the rim, its rim colored like a macro ring
(protein, carbs, fat) around a pink hub, glowing on a dark grid. Writes icons/icon.svg and the PNGs from the
same cells, without dependencies. PNGs are full-bleed squares, since iOS and Android mask the corners."""
import math, os, struct, zlib

N, CELL, ORIGIN = 16, 24, 64  # 16 × 16 grid of 24-unit cells inside the 512 canvas
GAP = CELL * .12
PINK, PROTEIN, CARBS, FAT = (0xff, 0x2b, 0xd6), (0x19, 0xe6, 0xff), (0xff, 0xd2, 0x3f), (0x3d, 0xff, 0x9e)
BG_TOP, BG_BOTTOM, GRID = (0x17, 0x0c, 0x2e), (0x05, 0x04, 0x0c), (0x19, 0xe6, 0xff)
GLOW = 9  # blur radius (standard deviation) of the glow, in 512 units


def color(x, y, d):
    # Rim colors run clockwise starting just past the bite, so each macro keeps a full arc.
    if d < 4:
        return PINK
    t = ((math.atan2(x, -y) / (2 * math.pi)) + 1 + .82) % 1
    return FAT if t < .3 else PROTEIN if t < .62 else CARBS


def cells():
    out = []
    for r in range(N):
        for c in range(N):
            x, y = c + .5 - N / 2, r + .5 - N / 2
            d = math.hypot(x, y)
            on = 5.2 <= d <= 7.6 or 1.6 <= d <= 3.0  # rim and hub
            bitten = math.hypot(c + .5 - 14.4, r + .5 - 1.8) <= 3.4
            if on and not bitten:
                out.append((c, r, color(x, y, d)))
    for c, r in [(15, 4), (12, 0)]:  # crumbs flying off the bite
        out.append((c, r, color(c + .5 - N / 2, r + .5 - N / 2, 99)))
    return out


def rect(c, r):
    x, y = ORIGIN + c * CELL + GAP / 2, ORIGIN + r * CELL + GAP / 2
    return x, y, CELL - GAP


# ---------------------------------------------------------------- svg

def svg():
    hexc = lambda c: '#%02x%02x%02x' % c
    rects = ''.join(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{w:g}" rx="{w * .1:.1f}" fill="{hexc(col)}"/>'
                    for c, r, col in cells() for x, y, w in [rect(c, r)])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{hexc(BG_TOP)}"/><stop offset="1" stop-color="{hexc(BG_BOTTOM)}"/></linearGradient>
    <radialGradient id="halo"><stop offset="0" stop-color="#ff2bd6" stop-opacity=".22"/><stop offset="1" stop-color="#ff2bd6" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#19e6ff" stroke-opacity=".09" stroke-width="2"/></pattern>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="{GLOW}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="round"><rect width="512" height="512" rx="112"/></clipPath>
  </defs>
  <g clip-path="url(#round)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="512" fill="url(#grid)"/>
    <circle cx="256" cy="256" r="282" fill="url(#halo)"/>
    <g filter="url(#glow)">{rects}</g>
  </g>
</svg>
'''


# ---------------------------------------------------------------- png

def render(size):
    k = size / 512
    px = lambda v: v * k
    # Background: vertical gradient, faint grid lines every 32 units, pink halo in the middle.
    img = []
    halo_r = 282 * k
    for py in range(size):
        t = (py + .5) / size
        base = [BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t for i in range(3)]
        row = []
        for pxl in range(size):
            col = base[:]
            ux, uy = (pxl + .5) / k, (py + .5) / k
            if (ux % 32) < 1 or (ux % 32) > 31 or (uy % 32) < 1 or (uy % 32) > 31:
                col = [col[i] + (GRID[i] - col[i]) * .09 for i in range(3)]
            h = max(0, 1 - math.hypot(pxl + .5 - size / 2, py + .5 - size / 2) / halo_r) * .22
            col = [col[i] + (PINK[i] - col[i]) * h for i in range(3)]
            row.append(col)
        img.append(row)

    # Cells as a premultiplied RGBA layer, with exact edge coverage for smooth edges at any size.
    layer = [[[0.0, 0.0, 0.0, 0.0] for _ in range(size)] for _ in range(size)]
    for c, r, col in cells():
        x, y, w = rect(c, r)
        x0, y0, x1, y1 = px(x), px(y), px(x + w), px(y + w)
        for py in range(int(y0), min(size, math.ceil(y1))):
            cy = min(py + 1, y1) - max(py, y0)
            for pxl in range(int(x0), min(size, math.ceil(x1))):
                a = cy * (min(pxl + 1, x1) - max(pxl, x0))
                if a <= 0:
                    continue
                cell = layer[py][pxl]
                for i in range(3):
                    cell[i] += col[i] * a
                cell[3] += a

    # Glow: Gaussian blur approximated by three box blurs, drawn twice under the sharp cells, like the SVG filter.
    sigma = GLOW * k
    box = max(1, round(math.sqrt(12 * sigma * sigma / 3 + 1))) | 1  # odd, so the window is centered
    blur = [[p[:] for p in row] for row in layer]
    for _ in range(3):
        blur = box_blur(blur, size, box)
    over = lambda dst, src: [src[i] + dst[i] * (1 - src[3]) for i in range(3)]
    for py in range(size):
        for pxl in range(size):
            col = img[py][pxl]
            for src in (blur[py][pxl], blur[py][pxl], layer[py][pxl]):
                if src[3] > 0:
                    col = over(col, src)
            img[py][pxl] = col

    raw = b''.join(b'\x00' + bytes(max(0, min(255, round(v))) for p in row for v in p) for row in img)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def box_blur(src, size, w):
    """Separable box blur of width w over a premultiplied RGBA grid, horizontally then vertically."""
    h = w // 2
    tmp = [[None] * size for _ in range(size)]
    for y in range(size):
        row, acc = src[y], [0.0] * 4
        for x in range(-h, size + h + 1):
            if 0 <= x + h < size:
                acc = [acc[i] + row[x + h][i] for i in range(4)]
            if 0 <= x - h - 1 < size:
                acc = [acc[i] - row[x - h - 1][i] for i in range(4)]
            if 0 <= x < size:
                tmp[y][x] = [v / w for v in acc]
    out = [[None] * size for _ in range(size)]
    for x in range(size):
        acc = [0.0] * 4
        for y in range(-h, size + h + 1):
            if 0 <= y + h < size:
                acc = [acc[i] + tmp[y + h][x][i] for i in range(4)]
            if 0 <= y - h - 1 < size:
                acc = [acc[i] - tmp[y - h - 1][x][i] for i in range(4)]
            if 0 <= y < size:
                out[y][x] = [v / w for v in acc]
    return out


out = os.path.join(os.path.dirname(__file__), '..', 'icons')
open(os.path.join(out, 'icon.svg'), 'w').write(svg())
print('icon.svg')
for name, size in [('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180)]:
    open(os.path.join(out, name), 'wb').write(render(size))
    print(name)
