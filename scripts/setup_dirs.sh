#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

mkdir -p "$BASE_DIR"/{raw,preprocessed,ocr,review,ground_truth}

cat <<MSG
Estructura creada/validada en:
  $BASE_DIR/raw
  $BASE_DIR/preprocessed
  $BASE_DIR/ocr
  $BASE_DIR/review
  $BASE_DIR/ground_truth
MSG
