#!/usr/bin/env bash
set -euo pipefail

INPUT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/raw}"
OUTPUT_DIR="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/preprocessed}"

if ! command -v magick >/dev/null 2>&1; then
  echo "Error: ImageMagick no esta instalado (comando 'magick')." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

shopt -s nullglob
files=(
  "$INPUT_DIR"/*.tif "$INPUT_DIR"/*.tiff "$INPUT_DIR"/*.png
  "$INPUT_DIR"/*.jpg "$INPUT_DIR"/*.jpeg
)

if [ ${#files[@]} -eq 0 ]; then
  echo "No se encontraron imagenes en $INPUT_DIR"
  exit 0
fi

for f in "${files[@]}"; do
  base="$(basename "$f")"
  name="${base%.*}"
  out="$OUTPUT_DIR/${name}.png"

  magick "$f" \
    -auto-orient \
    -deskew 40% \
    -colorspace Gray \
    -contrast-stretch 1%x1% \
    -sharpen 0x1.0 \
    "$out"

  echo "Preprocesada: $base -> $(basename "$out")"
done

echo "Preprocesado completado. Salida: $OUTPUT_DIR"
