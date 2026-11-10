"""Build the data bundle behind the Tunis urban-heat-island app.

Mirrors the DTT4SD hands-on notebook (github.com/brunocalet/DTT4SD-Tunis-UHI)
without Google Earth Engine, from archives that need no account:

  * Landsat 8 Collection 1 Level-1 (Google Cloud public data) -> land surface
    temperature from thermal band 10 (single-channel, NDVI emissivity).
  * ESA WorldCover 2021 v200 (10 m) -> share of each land-cover class inside
    every 90 m cell, the stand-in for Dynamic World's class probabilities.

Output: ../data.js (grid, rasters, Random Forest, sample pixels).
Run:    python build_data.py
"""
import base64, io, json, os, re, urllib.request
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds, transform, Resampling
from rasterio.windows import from_bounds
from sklearn.ensemble import RandomForestRegressor
from PIL import Image

from survey import AOI, scenes, clear_share

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".TIF,.tif")

SCALE = 90                    # metres, as in the notebook
CRS = "EPSG:32632"            # UTM 32N
PATH_ROW = ("191", "035")     # the Landsat frame that covers the whole study area
SUMMER = ("20210601", "20210901")
SEED = 42
WORLDCOVER = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
              "ESA_WorldCover_10m_2021_v200_N36E009_Map.tif")
# WorldCover codes -> the eight model inputs
CLASSES = [("trees", 10), ("shrub", 20), ("grass", 30), ("crops", 40),
           ("built", 50), ("bare", 60), ("water", 80), ("wetland", 90)]

# ---------------------------------------------------------------- grid
w, s, e, n = transform_bounds("EPSG:4326", CRS, *AOI)
W0, N0 = np.floor(w / SCALE) * SCALE, np.ceil(n / SCALE) * SCALE
NX, NY = int(np.ceil((e - W0) / SCALE)), int(np.ceil((N0 - s) / SCALE))
GRID = from_origin(W0, N0, SCALE, SCALE)
print(f"grid {NX} x {NY} cells of {SCALE} m")


def to_grid(src_arr, src_transform, src_crs, resampling, dtype="float32", nodata=np.nan):
    out = np.full((NY, NX), nodata, dtype=dtype)
    reproject(src_arr, out, src_transform=src_transform, src_crs=src_crs,
              dst_transform=GRID, dst_crs=CRS, resampling=resampling,
              src_nodata=nodata, dst_nodata=nodata)
    return out


# ---------------------------------------------------------------- land cover
def land_cover():
    with rasterio.open(f"/vsicurl/{WORLDCOVER}") as src:
        pad = 0.01
        win = from_bounds(AOI[0] - pad, AOI[1] - pad, AOI[2] + pad, AOI[3] + pad, src.transform)
        wc = src.read(1, window=win)
        tr = src.window_transform(win)
        crs = src.crs
    fractions = []
    for name, code in CLASSES:
        codes = (90, 95) if name == "wetland" else (code,)
        mask = np.isin(wc, codes).astype("float32")
        fractions.append(to_grid(mask, tr, crs, Resampling.average, nodata=-1))
    f = np.clip(np.stack(fractions), 0, 1)
    return f / np.maximum(f.sum(0), 1e-6)       # shares add up to 1


# ---------------------------------------------------------------- Landsat
def mtl(base):
    txt = urllib.request.urlopen(f"{base}_MTL.txt").read().decode()
    return {k: v.strip('"') for k, v in re.findall(r"(\w+) = (\S+)", txt)}


def read_band(base, band):
    with rasterio.open(f"/vsicurl/{base}_{band}.TIF") as src:
        b = transform_bounds(CRS, src.crs, w - 300, s - 300, e + 300, n + 300)
        win = from_bounds(*b, src.transform).round_offsets().round_lengths()
        return src.read(1, window=win).astype("float32"), src.window_transform(win), src.crs


def observe(base):
    """One overpass -> LST (deg C) on the grid, clouds removed, plus a true-colour image."""
    m = mtl(base)
    dn, tr, crs = read_band(base, "B10")
    qa, _, _ = read_band(base, "BQA")
    qa = qa.astype("uint16")
    refl = {}
    for b in (2, 3, 4, 5):
        d, _, _ = read_band(base, f"B{b}")
        r = d * float(m[f"REFLECTANCE_MULT_BAND_{b}"]) + float(m[f"REFLECTANCE_ADD_BAND_{b}"])
        refl[b] = r / np.sin(np.radians(float(m["SUN_ELEVATION"])))
    # thermal band: digital number -> radiance -> brightness temperature (K)
    rad = dn * float(m["RADIANCE_MULT_BAND_10"]) + float(m["RADIANCE_ADD_BAND_10"])
    bt = float(m["K2_CONSTANT_BAND_10"]) / np.log(float(m["K1_CONSTANT_BAND_10"]) / rad + 1)
    # emissivity from NDVI (threshold method), then surface temperature
    ndvi = (refl[5] - refl[4]) / (refl[5] + refl[4] + 1e-6)
    pv = np.clip((ndvi - 0.2) / 0.3, 0, 1) ** 2
    emis = np.where(ndvi < 0, 0.991, 0.986 + 0.004 * pv)
    lst = bt / (1 + (10.895e-6 * bt / 1.4388e-2) * np.log(emis)) - 273.15
    # quality band: fill, cloud, cloud shadow (high confidence), cirrus (high confidence)
    bad = (qa <= 1) | (((qa >> 4) & 1) == 1) | (((qa >> 7) & 3) == 3) | (((qa >> 11) & 3) == 3)
    lst[bad | (dn == 0)] = np.nan
    lst_grid = to_grid(lst, tr, crs, Resampling.average)
    rgb = np.stack([to_grid(refl[b], tr, crs, Resampling.average) for b in (4, 3, 2)], -1)
    return lst_grid, rgb, m


# ---------------------------------------------------------------- helpers
def b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode()


def pack_lst(lst):                       # 0.01 deg C steps, -32768 = no data
    return b64(np.where(np.isfinite(lst), np.round(lst * 100), -32768).astype("<i2"))


def jpeg(rgb):
    img = np.clip(np.nan_to_num(rgb) / 0.30, 0, 1) ** 0.8
    big = Image.fromarray((img * 255).astype("uint8")).resize((NX * 2, NY * 2), Image.BICUBIC)
    buf = io.BytesIO()
    big.save(buf, "JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def scores(obs, pred):
    err = pred - obs
    return {"r2": round(float(1 - (err ** 2).sum() / ((obs - obs.mean()) ** 2).sum()), 3),
            "rmse": round(float(np.sqrt((err ** 2).mean())), 2),
            "mae": round(float(np.abs(err).mean()), 2), "n": int(len(obs))}


def export_forest(rf):
    """Flatten the forest into typed arrays the browser can walk."""
    feat, thr, left, right, val, roots = [], [], [], [], [], []
    for est in rf.estimators_:
        t, off = est.tree_, len(feat)
        roots.append(off)
        feat += [int(f) if f >= 0 else -1 for f in t.feature]
        thr += [float(x) for x in t.threshold]
        left += [int(c) + off if c >= 0 else -1 for c in t.children_left]
        right += [int(c) + off if c >= 0 else -1 for c in t.children_right]
        val += [float(v) for v in t.value[:, 0, 0]]
    return {"n_trees": len(roots), "n_nodes": len(feat),
            "roots": b64(np.array(roots, "<i4")), "feat": b64(np.array(feat, "i1")),
            "thr": b64(np.array(thr, "<f4")), "left": b64(np.array(left, "<i4")),
            "right": b64(np.array(right, "<i4")), "val": b64(np.array(val, "<f4"))}


# ---------------------------------------------------------------- run
if __name__ == "__main__":
    # 3 · which days were clear?
    overpasses = []
    for day, base in scenes(PATH_ROW):
        cov, clr = clear_share(base)
        overpasses.append({"day": f"{day[:4]}-{day[4:6]}-{day[6:]}", "clear": round(100 * clr, 1), "base": base})
    summer = [o for o in overpasses if SUMMER[0] <= o["day"].replace("-", "") < SUMMER[1]]
    model_day = max(summer, key=lambda o: (o["clear"], o["day"]))        # the clearest summer day
    newest = max((o for o in overpasses if o["clear"] >= 50), key=lambda o: o["day"])  # a rule, not a choice
    print("model day", model_day["day"], "· newest clear overpass", newest["day"])

    frac = land_cover()                                 # 5 · land cover
    lst, rgb, meta = observe(model_day["base"])         # 4 · LST of the model day
    lst_new, rgb_new, meta_new = observe(newest["base"])  # 7 · the newest overpass

    names = [c[0] for c in CLASSES]
    land = frac[names.index("water")] < 0.5
    frac8 = np.round(frac * 255).astype("u1")            # what the browser receives
    X = (frac8.reshape(len(CLASSES), -1).T / 255).astype("float32")

    # 5.2 / 6.1 · 4000 random land pixels, 70 % train, 30 % test
    rng = np.random.default_rng(SEED)
    ok = np.flatnonzero(land.ravel() & np.isfinite(lst.ravel()))
    sample = rng.choice(ok, 4000, replace=False)
    is_test = rng.random(4000) < 0.3
    tr_i, te_i = sample[~is_test], sample[is_test]
    y = lst.ravel()

    # 6.2 · Random Forest, 100 trees, regression
    rf = RandomForestRegressor(n_estimators=100, min_samples_leaf=5, random_state=SEED, n_jobs=-1)
    rf.fit(X[tr_i], y[tr_i])
    pred_te = rf.predict(X[te_i])
    s_test = scores(y[te_i], pred_te)
    print("test", s_test)

    # 7.4 · the same model on the newest overpass
    y_new = lst_new.ravel()
    ok_new = np.flatnonzero(land.ravel() & np.isfinite(y_new))
    chk = np.random.default_rng(7).choice(ok_new, 3000, replace=False)
    pred_chk = rf.predict(X[chk])
    s_new = scores(y_new[chk], pred_chk)
    print("newest", s_new, "bias", float((pred_chk - y_new[chk]).mean()))

    # 8.2 · the notebook's default intervention: +0.3 trees in 16 ha between Gammarth and La Marsa
    xs, ys = transform("EPSG:4326", CRS, [10.2964, 10.3009], [36.9054, 36.9090])
    # cells whose centre lies inside the rectangle
    c0, c1 = int(np.ceil((xs[0] - W0) / SCALE - 0.5)), int(np.floor((xs[1] - W0) / SCALE - 0.5))
    r0, r1 = int(np.ceil((N0 - ys[1]) / SCALE - 0.5)), int(np.floor((N0 - ys[0]) / SCALE - 0.5))
    print("intervention cells: cols", c0, c1, "rows", r0, r1)

    PLACES = [("Medina", 10.1682, 36.7979), ("Lake of Tunis", 10.235, 36.818), ("La Marsa", 10.322, 36.880),
              ("Carthage", 10.322, 36.853), ("Ariana", 10.190, 36.865), ("Airport", 10.227, 36.850),
              ("Sebkha Sejoumi", 10.125, 36.770), ("Belvédère park", 10.172, 36.824),
              ("La Goulette", 10.303, 36.818), ("Sebkha Ariana", 10.250, 36.910), ("Manouba", 10.098, 36.809),
              ("Ben Arous", 10.228, 36.752), ("Radès", 10.274, 36.768), ("Gammarth", 10.290, 36.915)]
    px, py = transform("EPSG:4326", CRS, [p[1] for p in PLACES], [p[2] for p in PLACES])
    places = [[p[0], round((x - W0) / SCALE, 1), round((N0 - y) / SCALE, 1)] for p, x, y in zip(PLACES, px, py)]

    q = lambda a: [round(float(v), 2) for v in a]
    out = {
        "grid": {"nx": NX, "ny": NY, "scale": SCALE, "crs": CRS, "west": W0, "north": N0, "aoi": AOI,
                 "intervention": [c0, r0, c1, r1], "places": places},
        "classes": names,
        "frac": b64(frac8),          # [class][row][col], 0-255
        "model_day": {"day": model_day["day"], "lst": pack_lst(lst), "rgb": jpeg(rgb),
                      "scene": meta["LANDSAT_PRODUCT_ID"], "time_utc": meta["SCENE_CENTER_TIME"][:5]},
        "newest": {"day": newest["day"], "lst": pack_lst(lst_new), "rgb": jpeg(rgb_new),
                   "scene": meta_new["LANDSAT_PRODUCT_ID"], "time_utc": meta_new["SCENE_CENTER_TIME"][:5]},
        "overpasses": [{"day": o["day"], "clear": o["clear"]} for o in overpasses],
        "forest": export_forest(rf),
        "importance": dict(zip(names, q(rf.feature_importances_ * 100))),
        "split": {"train": int(len(tr_i)), "test": int(len(te_i)),
                  "train_idx": b64(tr_i.astype("<i4")), "test_idx": b64(te_i.astype("<i4"))},
        "test": {"scores": s_test, "obs": q(y[te_i]), "pred": q(pred_te)},
        "check": {"scores": s_new, "bias": round(float((pred_chk - y_new[chk]).mean()), 2),
                  "obs": q(y_new[chk][:1500]), "pred": q(pred_chk[:1500])},
    }
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "data.js"), "w") as f:
        f.write("window.UHI_DATA = " + json.dumps(out, separators=(",", ":")) + ";\n")
    print("wrote data.js", round(os.path.getsize(os.path.join(here, "..", "data.js")) / 1e6, 2), "MB")
