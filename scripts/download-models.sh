#!/bin/bash
# Download TTS models and ONNX runtime files
# Run this script after npm install

set -e

# Handle force download flag
FORCE_DOWNLOAD=false
if [[ "${1:-}" == "--force" ]] || [[ "${1:-}" == "-f" ]]; then
    FORCE_DOWNLOAD=true
    echo "Force download enabled - will re-download existing files"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PUBLIC_DIR="$PROJECT_ROOT/public"

echo "Setting up model directories..."

# Create directories
mkdir -p "$PUBLIC_DIR/models/tts"
mkdir -p "$PUBLIC_DIR/onnx"
mkdir -p "$PUBLIC_DIR/voice_styles"

# ============================================
# 1. Copy ONNX Runtime WASM files from node_modules
# ============================================
echo ""
echo "Copying ONNX Runtime WASM files..."

ONNX_SRC="$PROJECT_ROOT/node_modules/onnxruntime-web/dist"

if [ -d "$ONNX_SRC" ]; then
    cp "$ONNX_SRC/ort-wasm-simd-threaded.wasm" "$PUBLIC_DIR/onnx/"
    cp "$ONNX_SRC/ort-wasm-simd-threaded.mjs" "$PUBLIC_DIR/onnx/"
    cp "$ONNX_SRC/ort-wasm-simd-threaded.jsep.wasm" "$PUBLIC_DIR/onnx/"
    cp "$ONNX_SRC/ort-wasm-simd-threaded.jsep.mjs" "$PUBLIC_DIR/onnx/"
    echo "  ✓ ONNX Runtime WASM files copied"
else
    echo "  ✗ Error: onnxruntime-web not found. Run 'npm install' first."
    exit 1
fi

# ============================================
# 2. Download TTS models from Hugging Face (Supertonic)
# ============================================
echo ""
echo "Downloading TTS models from Hugging Face..."

# Supertonic models: https://huggingface.co/Supertone/supertonic
HF_BASE="https://huggingface.co/Supertone/supertonic/resolve/main/onnx"

# Model files to download
TTS_FILES=(
    "duration_predictor.onnx"
    "text_encoder.onnx"
    "vector_estimator.onnx"
    "vocoder.onnx"
    "tts.json"
    "unicode_indexer.json"
)

for file in "${TTS_FILES[@]}"; do
    if [ -f "$PUBLIC_DIR/models/tts/$file" ] && [ "$FORCE_DOWNLOAD" = false ]; then
        echo "  - $file (already exists, skipping)"
    else
        echo "  - Downloading $file..."
        curl -L -o "$PUBLIC_DIR/models/tts/$file" "$HF_BASE/$file" --progress-bar
    fi
done

echo "  ✓ TTS models downloaded"

# ============================================
# 3. Download voice styles from Hugging Face
# ============================================
echo ""
echo "Downloading voice styles..."

HF_VOICES="https://huggingface.co/Supertone/supertonic/resolve/main/voice_styles"

VOICE_FILES=("M1.json" "M2.json" "M3.json" "M4.json" "M5.json" "F1.json" "F2.json" "F3.json" "F4.json" "F5.json")

for file in "${VOICE_FILES[@]}"; do
    if [ -f "$PUBLIC_DIR/voice_styles/$file" ] && [ "$FORCE_DOWNLOAD" = false ]; then
        echo "  - $file (already exists, skipping)"
    else
        echo "  - Downloading $file..."
        curl -L -o "$PUBLIC_DIR/voice_styles/$file" "$HF_VOICES/$file" --progress-bar
    fi
done

echo "  ✓ Voice styles downloaded"

# ============================================
# Summary
# ============================================
echo ""
echo "============================================"
echo "Setup complete!"
echo ""
echo "Downloaded files:"
du -sh "$PUBLIC_DIR/models" "$PUBLIC_DIR/onnx" "$PUBLIC_DIR/voice_styles" 2>/dev/null || true
echo "============================================"
