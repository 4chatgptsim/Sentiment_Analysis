#!/usr/bin/env bash
# Packages extension/ as dist/snap-vanish.zip. Unzipping it gives a
# "snap-vanish" folder that can be loaded with chrome://extensions → Load unpacked.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
OUT="$ROOT/dist/snap-vanish.zip"

for f in vendor/mediapipe/vision_bundle.mjs vendor/mediapipe/vision_wasm_internal.wasm \
         vendor/ort/ort.wasm.bundle.min.mjs vendor/ort/ort-wasm-simd-threaded.wasm \
         models/hand_landmarker.task models/selfie_segmenter_landscape.tflite models/migan_pipeline_v2.onnx; do
  [ -f "$EXT/$f" ] || { echo "Missing $f — run scripts/fetch-vendor.sh first" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/snap-vanish" "$ROOT/dist"
cp -R "$EXT/." "$STAGE/snap-vanish/"
cp "$ROOT/INSTALL.txt" "$STAGE/snap-vanish/INSTALL.txt"
find "$STAGE" -name '.DS_Store' -delete
rm -f "$OUT"
(cd "$STAGE" && TZ=UTC zip -X -r -9 -q "$OUT" snap-vanish)
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
