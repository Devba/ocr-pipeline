#!/usr/bin/env bash
set -euo pipefail

INPUT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/preprocessed}"
OUTPUT_DIR="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ocr}"
LANG="${3:-spa}"
PSM="${4:-6}"

if ! command -v tesseract >/dev/null 2>&1; then
  echo "Error: Tesseract no esta instalado." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

shopt -s nullglob
files=("$INPUT_DIR"/*.png "$INPUT_DIR"/*.tif "$INPUT_DIR"/*.tiff "$INPUT_DIR"/*.jpg "$INPUT_DIR"/*.jpeg)

if [ ${#files[@]} -eq 0 ]; then
  echo "No se encontraron imagenes en $INPUT_DIR"
  exit 0
fi

for f in "${files[@]}"; do
  base="$(basename "$f")"
  name="${base%.*}"
  out_base="$OUTPUT_DIR/$name"

  tesseract "$f" "$out_base" -l "$LANG" --psm "$PSM" quiet
  echo "OCR: $base -> ${name}.txt"
done

echo "OCR completado. Salida: $OUTPUT_DIR"
