#!/usr/bin/env bash
# Render the documentation figures from the built viewer.
# Requires a local Chrome/Chromium; the viewer itself needs neither.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=docs/assets
mkdir -p "$OUT"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)" \
    "/opt/pw-browsers/chromium"; do
    if [ -n "$candidate" ] && { [ -x "$candidate" ] || command -v "$candidate" >/dev/null 2>&1; }; then
      CHROME="$candidate"
      break
    fi
  done
fi

if [ -z "$CHROME" ]; then
  echo "No Chrome/Chromium found; set CHROME=/path/to/chrome" >&2
  exit 1
fi

WIDTH=${WIDTH:-1500}
HEIGHT=${HEIGHT:-940}
SCALE=${SCALE:-2}

shoot() {
  local query="$1" target="$2" url="file://$PWD/index.html"
  if [ -n "$query" ]; then url="$url?$query"; fi
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor="$SCALE" --window-size="$WIDTH,$HEIGHT" \
    --virtual-time-budget=8000 \
    --screenshot="$target" "$url" >/dev/null 2>&1
  echo "rendered $target"
}

# cartography gate: the viewer runs a projection self-test at load and writes the result
# into <html data-cartography>. Refuse to publish figures if the page did not pass.
DOM="$(mktemp)"
"$CHROME" --headless=new --no-sandbox --disable-gpu --virtual-time-budget=6000 \
  --dump-dom "file://$PWD/index.html" > "$DOM" 2>/dev/null || true
if ! grep -q 'data-cartography="ok"' "$DOM"; then
  echo "cartography self-test failed — refusing to render figures" >&2
  grep -o 'data-cartography="[^"]*"\|data-jserror="[^"]*"' "$DOM" >&2 || true
  rm -f "$DOM"
  exit 1
fi
rm -f "$DOM"

shoot "" "$OUT/plan_view.png"
# Dakhla is ~6 km long, so the detail figures open zoomed on their subject.
shoot "mode=typology&zoom=3" "$OUT/typology_view.png"
shoot "mode=height&exag=3.2&sel=941&zoom=5" "$OUT/height_view.png"
shoot "sel=2394&zoom=5" "$OUT/selection_view.png"
shoot "cell=194&zoom=4" "$OUT/cell_view.png"

# keep README images light enough for GitHub
if command -v sips >/dev/null 2>&1; then
  for f in "$OUT/plan_view.png" "$OUT/typology_view.png" \
           "$OUT/height_view.png" "$OUT/selection_view.png" \
           "$OUT/cell_view.png"; do
    sips --resampleWidth 1600 "$f" >/dev/null
  done
fi

ls -lh "$OUT"
