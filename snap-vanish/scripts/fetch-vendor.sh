#!/usr/bin/env bash
# Downloads the third-party runtime files and AI models that Snap Vanish
# bundles (so that nothing is ever downloaded at run time) into extension/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MEDIAPIPE_VERSION="1.1.1"
ORT_VERSION="1.30.0"
MIGAN_PKG_VERSION="1.0.0"
MP_MODELS="https://storage.googleapis.com/mediapipe-models"

mkdir -p "$EXT/vendor/mediapipe" "$EXT/vendor/ort" "$EXT/models"

echo "› MediaPipe Tasks Vision $MEDIAPIPE_VERSION"
(cd "$TMP" && npm pack --silent "@mediapipe/tasks-vision@$MEDIAPIPE_VERSION" >/dev/null && mkdir mp && tar xzf mediapipe-tasks-vision-*.tgz -C mp)
cp "$TMP/mp/package/vision_bundle.mjs" "$EXT/vendor/mediapipe/"
cp "$TMP/mp/package/wasm/vision_wasm_internal.js" "$TMP/mp/package/wasm/vision_wasm_internal.wasm" "$EXT/vendor/mediapipe/"

echo "› ONNX Runtime Web $ORT_VERSION (WebAssembly build)"
(cd "$TMP" && npm pack --silent "onnxruntime-web@$ORT_VERSION" >/dev/null && mkdir ort && tar xzf onnxruntime-web-*.tgz -C ort)
cp "$TMP/ort/package/dist/ort.wasm.bundle.min.mjs" "$TMP/ort/package/dist/ort-wasm-simd-threaded.mjs" \
   "$TMP/ort/package/dist/ort-wasm-simd-threaded.wasm" "$EXT/vendor/ort/"

echo "› MediaPipe models"
curl -fsSL -o "$EXT/models/hand_landmarker.task" "$MP_MODELS/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
curl -fsSL -o "$EXT/models/selfie_segmenter_landscape.tflite" "$MP_MODELS/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite"

echo "› MI-GAN 512 Places2 inpainting pipeline (ONNX)"
# Official file: https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx
# Also mirrored on npm (migan-onnx), which is used here.
if ! curl -fsSL -o "$EXT/models/migan_pipeline_v2.onnx" "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx" 2>/dev/null; then
  (cd "$TMP" && npm pack --silent "migan-onnx@$MIGAN_PKG_VERSION" >/dev/null && mkdir migan && tar xzf migan-onnx-*.tgz -C migan)
  cp "$TMP/migan/package/models/migan_pipeline_v2.onnx" "$EXT/models/"
fi

echo "Done. Vendor files:"
du -sh "$EXT/vendor" "$EXT/models"
