#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$BASE_DIR/scripts/setup_dirs.sh" "$BASE_DIR"
"$BASE_DIR/scripts/preprocess_images.sh" "$BASE_DIR/raw" "$BASE_DIR/preprocessed"
"$BASE_DIR/scripts/ocr_tesseract.sh" "$BASE_DIR/preprocessed" "$BASE_DIR/ocr" "spa" "6"

echo "Pipeline base finalizado."
echo "Siguiente paso recomendado: subir 'preprocessed/' a Transkribus para HTR de mayor precision."
