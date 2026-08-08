#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export COREF_PRELOAD="${COREF_PRELOAD:-1}"
export COREF_CUDA_DEVICE="${COREF_CUDA_DEVICE:--1}"

exec "$ROOT_DIR/trpg_env/bin/python" -m uvicorn app:app --host 0.0.0.0 --port 8000
