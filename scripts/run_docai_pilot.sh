#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="${DOC_AI_PROJECT_ID:-$(gcloud config get-value core/project 2>/dev/null || true)}"
LOCATION="${DOC_AI_LOCATION:-us}"
PROCESSOR_ID="${DOC_AI_PROCESSOR_ID:-20059bb740004006}"
INPUT_DIR="${DOC_AI_INPUT_DIR:-raw}"
OUTPUT_DIR="${DOC_AI_OUTPUT_DIR:-ocr_docai}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "ERROR: No hay proyecto activo en gcloud. Ejecuta: gcloud config set project TU_PROJECT_ID" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 no está disponible." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud no está disponible." >&2
  exit 1
fi

echo "Proyecto:   $PROJECT_ID"
echo "Región:     $LOCATION"
echo "Processor:  $PROCESSOR_ID"
echo "Input dir:  $INPUT_DIR"
echo "Output dir: $OUTPUT_DIR"

echo "\n== Preparando venv (.venv-docai) =="
if [[ ! -d .venv-docai ]]; then
  python3 -m venv .venv-docai
fi

# shellcheck disable=SC1091
. .venv-docai/bin/activate

python -m pip -q install --upgrade pip
pip -q install google-cloud-documentai

echo "\n== Ejecutando OCR (Document AI) =="
mkdir -p "$OUTPUT_DIR"
python scripts/docai_ocr.py \
  --input_dir "$INPUT_DIR" \
  --output_dir "$OUTPUT_DIR" \
  --project_id "$PROJECT_ID" \
  --location "$LOCATION" \
  --processor_id "$PROCESSOR_ID" \
  --skip_existing

echo "\n== CER (si hay ground truth) =="
if compgen -G "ground_truth/*.txt" >/dev/null; then
  python3 scripts/compute_cer.py --gt_dir ground_truth --ocr_dir "$OUTPUT_DIR"
else
  echo "No hay ground truth en ground_truth/*.txt; omitiendo CER."
fi

echo "\nListo. Resultados en: $OUTPUT_DIR/"
