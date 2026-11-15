"""Builds a PS1-style rusty oil barrel as a Godot-ready GLB, without Blender.

Outputs (next to this script):
  SM_Prop_Barrel_Rusty_01.glb   mesh + convex collider, +Y up, pivot at floor centre
  T_Barrel_Rusty_BC.png         128x128 base-colour texture (also embedded in the GLB)
  preview.png                   software-rendered preview

Run: python3 build_barrel.py
"""
import io
import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent
N = 12            # sides
HEIGHT = 0.88     # metres, 55-gallon drum
TEX = 128
SIDE_V0 = 0.25    # bottom quarter of the texture holds the two caps
rng = np.random.default_rng(7)

# (radius, height) profile from bottom centre to top centre, Z up.
PROFILE = [
    (0.0, 0.0), (0.285, 0.0), (0.285, 0.27), (0.30, 0.30), (0.285, 0.33),
    (0.285, 0.55), (0.30, 0.58), (0.285, 0.61), (0.29, 0.88),
    (0.265, 0.88), (0.255, 0.855), (0.0, 0.855),
]
FIRST_SIDE, LAST_SIDE = 1, 8          # profile indices that bound the side wall


def build_mesh():
    """Returns flat-shaded triangle soup: positions, normals, uvs (v up)."""
    ring = np.zeros((len(PROFILE), N + 1, 3))
    for j, (r, z) in enumerate(PROFILE):
        for i in range(N + 1):
            a = 2 * math.pi * (i % N) / N
            ring[j, i] = (r * math.cos(a), r * math.sin(a), z)
    # A dent between the ribs, for a damaged silhouette.
    for j, scale in ((4, 0.86), (5, 0.90)):
        ring[j, 3, :2] *= scale
        ring[j, 4, :2] *= 0.95

    def uv(j, i, band):
        p = ring[j, i]
        if band < FIRST_SIDE:                      # bottom cap, planar
            return (0.125 + p[0] / 0.30 * 0.115, 0.125 + p[1] / 0.30 * 0.115)
        if band >= LAST_SIDE:                      # top rim and lid, planar
            return (0.375 + p[0] / 0.30 * 0.115, 0.125 + p[1] / 0.30 * 0.115)
        return (i / N, SIDE_V0 + (1 - SIDE_V0) * p[2] / HEIGHT)

    pos, nrm, uvs = [], [], []
    for band in range(len(PROFILE) - 1):
        (r0, z0), (r1, z1) = PROFILE[band], PROFILE[band + 1]
        hint_rz = (z1 - z0, -(r1 - r0))            # outward side of the profile
        for i in range(N):
            quad = [(band, i), (band, i + 1), (band + 1, i + 1), (band + 1, i)]
            tris = [quad[:3], [quad[0], quad[2], quad[3]]]
            a_mid = 2 * math.pi * (i + 0.5) / N
            hint = np.array([hint_rz[0] * math.cos(a_mid), hint_rz[0] * math.sin(a_mid), hint_rz[1]])
            for tri in tris:
                p = [ring[j, k] for j, k in tri]
                n = np.cross(p[1] - p[0], p[2] - p[0])
                if np.linalg.norm(n) < 1e-9:       # collapsed at the centre
                    continue
                if n @ hint < 0:
                    tri = [tri[0], tri[2], tri[1]]
                    p = [p[0], p[2], p[1]]
                    n = -n
                n /= np.linalg.norm(n)
                for (j, k), q in zip(tri, p):
                    pos.append(q)
                    nrm.append(n)
                    uvs.append(uv(j, k, band))
    return np.array(pos, np.float32), np.array(nrm, np.float32), np.array(uvs, np.float32)


def build_collider():
    """8-sided convex prism, indexed."""
    m, r = 8, 0.29
    v = [(r * math.cos(2 * math.pi * i / m), r * math.sin(2 * math.pi * i / m), z)
         for z in (0.0, HEIGHT) for i in range(m)]
    idx = []
    for i in range(m):
        k = (i + 1) % m
        idx += [i, k, m + k, i, m + k, m + i]
    for i in range(1, m - 1):
        idx += [0, i + 1, i, m, m + i, m + i + 1]
    return np.array(v, np.float32), np.array(idx, np.uint16)


def noise(w, h, cells):
    """Value noise that tiles horizontally."""
    g = rng.random((cells + 1, cells))
    ys = np.linspace(0, cells, h, endpoint=False)
    xs = np.linspace(0, cells, w, endpoint=False)
    y0, x0 = ys.astype(int), xs.astype(int)
    fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
    x1 = (x0 + 1) % cells
    top = g[y0][:, x0] * (1 - fx) + g[y0][:, x1] * fx
    bot = g[y0 + 1][:, x0] * (1 - fx) + g[y0 + 1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def build_texture():
    """128x128 RGB, row 0 = bottom (v = 0)."""
    paint = np.array([52, 84, 80], float)
    rust_a = np.array([118, 62, 28], float)
    rust_b = np.array([66, 34, 20], float)
    label = np.array([150, 142, 118], float)
    img = np.zeros((TEX, TEX, 3))

    # --- side wall ---
    y0 = int(SIDE_V0 * TEX)
    sh = TEX - y0
    h = np.linspace(0, 1, sh)[:, None] * np.ones((1, TEX))
    u = np.ones((sh, 1)) * np.linspace(0, 1, TEX, endpoint=False)[None, :]
    n = 0.55 * noise(TEX, sh, 4) + 0.3 * noise(TEX, sh, 8) + 0.15 * noise(TEX, sh, 16)
    fine = noise(TEX, sh, 32)
    side = paint * (0.8 + 0.4 * fine[..., None])

    lab = (h > 0.42) & (h < 0.57) & (u > 0.08) & (u < 0.36)
    side[lab] = label * (0.85 + 0.3 * fine[lab][:, None])
    bars = lab & (((h > 0.45) & (h < 0.475)) | ((h > 0.51) & (h < 0.535))) & (u > 0.11) & (u < 0.31)
    side[bars] = (30, 28, 26)

    ribs = (0.30 / HEIGHT, 0.58 / HEIGHT)
    bias = 0.45 * np.exp(-h / 0.10) + 0.30 * np.exp(-(1 - h) / 0.06)
    for rb in ribs:
        bias += 0.28 * np.exp(-((h - rb) / 0.035) ** 2)
        streak = (noise(TEX, 1, 24) > 0.62) * np.clip((rb - h) / 0.22, 0, 1) * (h < rb)
        bias += 0.30 * streak * (1 - np.clip((rb - h) / 0.22, 0, 1))
    rust = n + bias
    edge = (rust > 0.60) & (rust <= 0.66)
    mid = (rust > 0.66) & (rust <= 0.80)
    deep = rust > 0.80
    side[edge] = rust_b * 0.8
    side[mid] = rust_a * (0.8 + 0.4 * fine[mid][:, None])
    side[deep] = rust_b * (0.8 + 0.4 * fine[deep][:, None])

    for rb in ribs:                                   # painted-in rib shading
        r = int(rb * (sh - 1))
        side[r] *= 1.35
        side[r - 2:r] *= 0.6
    side *= (0.62 + 0.38 * np.clip(h * 2.2, 0, 1))[..., None]   # grime toward the floor
    img[y0:] = side

    # --- caps (bottom at u 0.125, top at u 0.375) ---
    strip = np.tile(rust_b * 0.6, (y0, TEX, 1))
    yy, xx = np.mgrid[0:y0, 0:TEX]
    cn = noise(TEX, y0, 8)
    for cx, is_top in ((0.125 * TEX, False), (0.375 * TEX, True)):
        d = np.hypot(xx + 0.5 - cx, yy + 0.5 - 0.125 * TEX) / (0.115 * TEX)
        disc = d < 1.08
        col = np.where((cn > 0.5)[..., None], rust_a * 0.8, paint * 0.75)
        strip[disc] = (col * (0.8 + 0.3 * cn[..., None]))[disc]
        strip[disc & (d > 0.86)] = paint * 1.15       # rim
        if is_top:
            strip[disc & (d > 0.78) & (d <= 0.86)] = (22, 20, 18)   # recess shadow
            bung = np.hypot(xx + 0.5 - (cx + 6), yy + 0.5 - (0.125 * TEX + 5)) < 2.2
            strip[bung] = (16, 14, 12)
    img[:y0] = strip

    rgb = np.clip(img, 0, 255).astype(np.uint8)
    pil = Image.fromarray(rgb[::-1].copy(), "RGB")
    pil = pil.quantize(16, dither=Image.Dither.NONE).convert("RGB")   # indexed-colour feel
    return np.asarray(pil)[::-1].copy(), pil


def to_y_up(v):
    return np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1).astype(np.float32)


def write_glb(pos, nrm, uvs, col_pos, col_idx, png_bytes, path):
    blob, views = bytearray(), []

    def add(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target:
            view["target"] = target
        blob.extend(data)
        views.append(view)
        return len(views) - 1

    p, n = to_y_up(pos), to_y_up(nrm)
    t = np.stack([uvs[:, 0], 1 - uvs[:, 1]], axis=1).astype(np.float32)   # glTF v runs down
    cp = to_y_up(col_pos)
    acc = [
        {"bufferView": add(p.tobytes(), 34962), "componentType": 5126, "count": len(p), "type": "VEC3",
         "min": p.min(0).tolist(), "max": p.max(0).tolist()},
        {"bufferView": add(n.tobytes(), 34962), "componentType": 5126, "count": len(n), "type": "VEC3"},
        {"bufferView": add(t.tobytes(), 34962), "componentType": 5126, "count": len(t), "type": "VEC2"},
        {"bufferView": add(cp.tobytes(), 34962), "componentType": 5126, "count": len(cp), "type": "VEC3",
         "min": cp.min(0).tolist(), "max": cp.max(0).tolist()},
        {"bufferView": add(col_idx.tobytes(), 34963), "componentType": 5123, "count": len(col_idx),
         "type": "SCALAR"},
    ]
    img_view = add(png_bytes)
    gltf = {
        "asset": {"version": "2.0", "generator": "build_barrel.py"},
        "scene": 0,
        "scenes": [{"name": "SM_Prop_Barrel_Rusty_01", "nodes": [0, 1]}],
        "nodes": [
            {"name": "SM_Prop_Barrel_Rusty_01", "mesh": 0},
            # Godot's importer turns "-convcolonly" nodes into a convex collision shape.
            {"name": "UCX_SM_Prop_Barrel_Rusty_01-convcolonly", "mesh": 1},
        ],
        "meshes": [
            {"name": "SM_Prop_Barrel_Rusty_01",
             "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "material": 0}]},
            {"name": "UCX_SM_Prop_Barrel_Rusty_01",
             "primitives": [{"attributes": {"POSITION": 3}, "indices": 4}]},
        ],
        "materials": [{
            "name": "MAT_Metal_Barrel_Rusty",
            "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0,
                                     "roughnessFactor": 1.0},
        }],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 10497, "wrapT": 33071}],
        "images": [{"name": "T_Barrel_Rusty_BC", "bufferView": img_view, "mimeType": "image/png"}],
        "accessors": acc,
        "bufferViews": views,
        "buffers": [{"byteLength": 0}],
    }
    while len(blob) % 4:
        blob.append(0)
    gltf["buffers"][0]["byteLength"] = len(blob)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))


def render_preview(pos, nrm, uvs, tex, path, w=320, h=240, scale=3):
    """Tiny z-buffer rasteriser: one point light, dark ambient, distance fog."""
    eye = np.array([0.55, -1.75, 1.20])
    target = np.array([0.0, 0.0, 0.40])
    light = np.array([0.9, -1.6, 1.5])
    fog_col = np.array([10.0, 12.0, 14.0])
    fwd = target - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    f = (h / 2) / math.tan(math.radians(38) / 2)

    # Floor: a dark checker so the barrel sits on something.
    fl = []
    for gx in range(-4, 4):
        for gy in range(-4, 4):
            a, b = gx * 0.5, gy * 0.5
            shade = 34 if (gx + gy) % 2 else 26
            for tri in (((a, b), (a + .5, b), (a + .5, b + .5)), ((a, b), (a + .5, b + .5), (a, b + .5))):
                fl.append(([(x, y, 0.0) for x, y in tri], shade))

    color = np.tile(fog_col, (h, w, 1))
    zbuf = np.full((h, w), np.inf)

    def draw(p3, normal, shade_fn):
        cam = np.array([[(q - eye) @ right, (q - eye) @ up, (q - eye) @ fwd] for q in p3])
        if (cam[:, 2] < 0.05).any():
            return
        sx = w / 2 + f * cam[:, 0] / cam[:, 2]
        sy = h / 2 - f * cam[:, 1] / cam[:, 2]
        x0, x1 = max(int(sx.min()), 0), min(int(sx.max()) + 1, w - 1)
        y0, y1 = max(int(sy.min()), 0), min(int(sy.max()) + 1, h - 1)
        if x0 > x1 or y0 > y1:
            return
        gy, gx = np.mgrid[y0:y1 + 1, x0:x1 + 1]
        px, py = gx + 0.5, gy + 0.5
        den = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2])
        if abs(den) < 1e-9:
            return
        b0 = ((sy[1] - sy[2]) * (px - sx[2]) + (sx[2] - sx[1]) * (py - sy[2])) / den
        b1 = ((sy[2] - sy[0]) * (px - sx[2]) + (sx[0] - sx[2]) * (py - sy[2])) / den
        b2 = 1 - b0 - b1
        inside = (b0 >= 0) & (b1 >= 0) & (b2 >= 0)
        iz = b0 / cam[0, 2] + b1 / cam[1, 2] + b2 / cam[2, 2]
        z = 1 / np.maximum(iz, 1e-9)
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        vis = inside & (z < sub)
        if not vis.any():
            return
        pc = [b0 / cam[0, 2] * z, b1 / cam[1, 2] * z, b2 / cam[2, 2] * z]   # perspective-correct
        world = sum(pc[k][..., None] * np.asarray(p3[k]) for k in range(3))
        base = shade_fn(pc)
        to_l = light - world
        dist = np.linalg.norm(to_l, axis=-1, keepdims=True)
        lam = np.clip((to_l / dist) @ normal, 0, 1)[..., None] / (0.35 + 0.25 * dist ** 2)
        lit = base * (0.10 + 1.25 * lam)
        fog = np.clip((z - 1.2) / 3.0, 0, 1)[..., None]
        out = lit * (1 - fog) + fog_col * fog
        color[y0:y1 + 1, x0:x1 + 1][vis] = out[vis]
        sub[vis] = z[vis]

    for tri, shade in fl:
        draw(tri, np.array([0, 0, 1.0]), lambda pc, s=shade: np.full(pc[0].shape + (3,), float(s)))
    for i in range(0, len(pos), 3):
        if nrm[i] @ (eye - pos[i]) <= 0:
            continue
        tuv = uvs[i:i + 3]

        def sample(pc, tuv=tuv):
            uu = sum(pc[k] * tuv[k, 0] for k in range(3)) % 1.0
            vv = np.clip(sum(pc[k] * tuv[k, 1] for k in range(3)), 0, 0.9999)
            return tex[(vv * TEX).astype(int), (uu * TEX).astype(int)].astype(float)

        draw([pos[i + k].astype(float) for k in range(3)], nrm[i].astype(float), sample)

    out = (np.clip(color, 0, 255) // 8 * 8).astype(np.uint8)        # 15-bit colour crush
    Image.fromarray(out).resize((w * scale, h * scale), Image.NEAREST).save(path)


def main():
    pos, nrm, uvs = build_mesh()
    col_pos, col_idx = build_collider()
    tex, pil = build_texture()
    pil.save(OUT / "T_Barrel_Rusty_BC.png")
    buf = io.BytesIO()
    pil.save(buf, "PNG", optimize=True)
    write_glb(pos, nrm, uvs, col_pos, col_idx, buf.getvalue(), OUT / "SM_Prop_Barrel_Rusty_01.glb")
    render_preview(pos, nrm, uvs, tex, OUT / "preview.png")
    print(f"triangles: {len(pos) // 3}  collider triangles: {len(col_idx) // 3}")
    print(f"bounds (Z up): {pos.min(0).round(3)} .. {pos.max(0).round(3)}")
    print(f"uv range: {uvs.min(0).round(3)} .. {uvs.max(0).round(3)}")


if __name__ == "__main__":
    main()
