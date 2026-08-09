#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PORT="${1:-8001}"

if [[ "${2:-}" == "--skip-preload" ]]; then
  export COREF_PRELOAD=0
fi

PYTHON="${WSL_PYTHON:-$PROJECT_DIR/trpg_env/bin/python}"

if [[ ! -x "$PYTHON" ]]; then
  echo "WSL Python environment not found or not executable: $PYTHON" >&2
  echo "Expected project path: $PROJECT_DIR" >&2
  exit 1
fi

cd "$PROJECT_DIR"
echo "Starting WSL backend from $PROJECT_DIR"
echo "Using Python: $PYTHON"
echo "Listening on 0.0.0.0:$PORT"

exec "$PYTHON" -m uvicorn app:app --host 0.0.0.0 --port "$PORT"
