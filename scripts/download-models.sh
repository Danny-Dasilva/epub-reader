#!/bin/bash
# Download the Sky v3 Inflect voice and ONNX Runtime browser assets.

set -euo pipefail

FORCE_DOWNLOAD=false
if [[ "${1:-}" == "--force" ]] || [[ "${1:-}" == "-f" ]]; then
    FORCE_DOWNLOAD=true
    echo "Force download enabled - will re-download existing files"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PUBLIC_DIR="$PROJECT_ROOT/public"
VOICE_DIR="$PUBLIC_DIR/models/inflect/sky-v3"

echo "Setting up Inflect model directories..."
mkdir -p "$VOICE_DIR/onnx" "$PUBLIC_DIR/onnx"

echo ""
echo "Copying ONNX Runtime WASM files..."
ONNX_SRC="$PROJECT_ROOT/node_modules/onnxruntime-web/dist"
if [[ ! -d "$ONNX_SRC" ]]; then
    echo "  ✗ onnxruntime-web not found. Run npm install first."
    exit 1
fi

for file in \
    ort-wasm-simd-threaded.wasm \
    ort-wasm-simd-threaded.mjs \
    ort-wasm-simd-threaded.jsep.wasm \
    ort-wasm-simd-threaded.jsep.mjs; do
    cp "$ONNX_SRC/$file" "$PUBLIC_DIR/onnx/$file"
done
echo "  ✓ ONNX Runtime WASM files copied"

echo ""
echo "Downloading Sky v3 from Danny-Dasilva/inflect-kokoro-voices..."
HF_BASE="https://huggingface.co/Danny-Dasilva/inflect-kokoro-voices/resolve/main/sky-v3"
MODEL_FILES=(
    "LICENSE"
    "THIRD_PARTY_NOTICES.md"
    "config.json"
    "symbols.json"
    "frontend.json"
    "onnx/duration.onnx"
    "onnx/decode.onnx"
)

for file in "${MODEL_FILES[@]}"; do
    destination="$VOICE_DIR/$file"
    if [[ -f "$destination" ]] && [[ "$FORCE_DOWNLOAD" == false ]]; then
        echo "  - $file (already exists, skipping)"
    else
        echo "  - Downloading $file..."
        curl --fail --location --output "$destination" "$HF_BASE/$file" --progress-bar
    fi
done

echo "  ✓ Sky v3 downloaded"
echo ""
echo "Setup complete:"
du -sh "$VOICE_DIR" "$PUBLIC_DIR/onnx" 2>/dev/null || true
