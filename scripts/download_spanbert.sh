#!/usr/bin/env bash
set -euo pipefail

MODEL_ID="${MODEL_ID:-SpanBERT/spanbert-large-cased}"
HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${TARGET_DIR:-$PROJECT_DIR/data/spanbert-large-cased}"

files=(
  "config.json"
  "pytorch_model.bin"
  "vocab.txt"
)

mkdir -p "$TARGET_DIR"

echo "Downloading $MODEL_ID from $HF_ENDPOINT"
echo "Target: $TARGET_DIR"

for file in "${files[@]}"; do
  url="${HF_ENDPOINT%/}/${MODEL_ID}/resolve/main/${file}"
  out="$TARGET_DIR/$file"
  echo
  echo "==> $file"
  curl -L --fail --retry 8 --retry-delay 5 --connect-timeout 30 -C - \
    "$url" \
    -o "$out"
done

if [ ! -f "$TARGET_DIR/tokenizer_config.json" ]; then
  cat > "$TARGET_DIR/tokenizer_config.json" <<'JSON'
{
  "do_lower_case": false,
  "model_max_length": 512
}
JSON
fi

echo
echo "Done. Files in $TARGET_DIR:"
ls -lh "$TARGET_DIR"
