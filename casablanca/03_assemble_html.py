"""Step 2b — Assemble the single self-contained HTML file.

Inlines (in order): three.min.js, OrbitControls, Pass, MaskPass,
EffectComposer, RenderPass, ShaderPass, CopyShader,
LuminosityHighPassShader, UnrealBloomPass, patched earcut, the packed
data payload (`const P = {...}`), and the app runtime. No network
requests at runtime.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LIBS = os.path.join(HERE, "libs")
OUT = os.path.join(HERE, "casablanca-night-grid.html")

SCRIPT_ORDER = [
    "three/build/three.min.js",
    "three/examples/js/controls/OrbitControls.js",
    "three/examples/js/postprocessing/Pass.js",
    "three/examples/js/postprocessing/MaskPass.js",  # EffectComposer needs it
    "three/examples/js/postprocessing/EffectComposer.js",
    "three/examples/js/postprocessing/RenderPass.js",
    "three/examples/js/postprocessing/ShaderPass.js",
    "three/examples/js/shaders/CopyShader.js",
    "three/examples/js/shaders/LuminosityHighPassShader.js",
    "three/examples/js/postprocessing/UnrealBloomPass.js",
]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def earcut_patched():
    src = read(os.path.join(LIBS, "earcut/src/earcut.js"))
    src = src.replace("module.exports = earcut;", "window.earcut = earcut;")
    src = src.replace("module.exports.default = earcut;\n", "")
    assert "module.exports" not in src
    return src


HTML_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Casablanca // night grid</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden;
               background: #07090c; }
  canvas { display: block; }
  #panel {
    position: fixed; top: 16px; left: 16px; z-index: 10;
    background: rgba(13, 16, 21, .85);
    border: 1px solid #232a35; border-radius: 12px;
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    padding: 14px 16px; width: 250px;
    font: 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #e8ebef; user-select: none;
  }
  #panel h1 { font-size: 14px; font-weight: 600; margin: 0 0 6px;
              letter-spacing: .4px; }
  #panel .muted { color: #8b95a3; }
  #panel .counts { margin: 0 0 10px; }
  #legend {
    height: 10px; border-radius: 5px; margin: 2px 0 4px;
    background: linear-gradient(90deg,
      #1b2b4a 0%, #7484a6 45%, #9fd8e8 75%, #eaffff 100%);
  }
  #legendLabels { display: flex; justify-content: space-between;
                  font-size: 11px; color: #8b95a3; margin-bottom: 10px; }
  #panel label { display: flex; align-items: center; gap: 8px;
                 margin: 6px 0; cursor: pointer; }
  #panel input[type="checkbox"] { accent-color: #ff2d95; width: 14px;
                                  height: 14px; cursor: pointer; }
  #hint { margin-top: 10px; font-size: 11px; color: #8b95a3; }
</style>
</head>
<body>
<div id="panel">
  <h1>Casablanca // night grid</h1>
  <div class="counts muted">
    <span id="nBld">…</span> buildings ·
    <span id="nRoad">…</span> road segments
  </div>
  <div id="legend"></div>
  <div id="legendLabels"><span>6 m</span><span>height (log)</span><span>320 m+</span></div>
  <label><input type="checkbox" id="cbBloom" checked> Bloom glow</label>
  <label><input type="checkbox" id="cbScan" checked> Floor scanlines</label>
  <label><input type="checkbox" id="cbPulse" checked> City pulse</label>
  <div id="hint">drag rotate &middot; right-drag pan &middot; scroll zoom</div>
</div>
"""

HTML_TAIL = """</body>
</html>
"""


def main():
    with open(os.path.join(HERE, "payload.json")) as f:
        payload = f.read()
    # sanity: it parses
    meta = json.loads(payload)["meta"]

    parts = [HTML_HEAD]
    for rel in SCRIPT_ORDER:
        src = read(os.path.join(LIBS, rel))
        parts.append(f"<script>/* {os.path.basename(rel)} */\n{src}\n</script>\n")
    parts.append(f"<script>/* earcut 2.2.4 (patched to window.earcut) */\n"
                 f"{earcut_patched()}\n</script>\n")
    parts.append(f"<script>\nconst P = {payload};\n</script>\n")
    parts.append(f"<script>\n{read(os.path.join(HERE, 'app.js'))}\n</script>\n")
    parts.append(HTML_TAIL)

    html = "".join(parts)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"✓ {OUT}: {len(html) / 1e6:.2f} MB, "
          f"{meta['nBld']} buildings, {meta['nRoad']} road polylines")


if __name__ == "__main__":
    main()
