# OCR pipeline para manuscritos (siglo XX)

Pipeline local para organizar, preprocesar y hacer OCR base.

## Estructura

- `raw/`: escaneos originales (TIFF/PNG/JPG)
- `preprocessed/`: imagenes limpias para OCR/HTR
- `ocr/`: texto OCR (`.txt`)
- `ground_truth/`: transcripciones manuales (`.txt`)
- `review/`: notas de correccion

## Requisitos

- Bash
- ImageMagick (`magick`)
- Tesseract OCR (idioma `spa`)
- Python 3 (para calcular CER)

## Uso rapido

1. Copia imagenes en `raw/`.
2. Ejecuta pipeline base:

```bash
bash ocr-pipeline/run_pipeline.sh
```

3. (Opcional) Evalua CER cuando tengas transcripciones de referencia:

```bash
python3 ocr-pipeline/scripts/compute_cer.py \
  --gt_dir ocr-pipeline/ground_truth \
  --ocr_dir ocr-pipeline/ocr
```

## Uso por etapas

```bash
bash ocr-pipeline/scripts/setup_dirs.sh ocr-pipeline
bash ocr-pipeline/scripts/preprocess_images.sh ocr-pipeline/raw ocr-pipeline/preprocessed
bash ocr-pipeline/scripts/ocr_tesseract.sh ocr-pipeline/preprocessed ocr-pipeline/ocr spa 6
```

## Web OCR (MVP)

Interfaz local para subir una imagen manuscrita y extraer texto con Tesseract en español.

### Requisitos extra

- Node.js + npm
- Tesseract + modelo español (`tesseract-ocr` y `tesseract-ocr-spa`)

### Ejecutar

```bash
cd ocr-pipeline
chmod +x run_web.sh
bash run_web.sh
```

Abre en navegador: `http://localhost:8000`

### Notas

- Perfil **Histórico** aplica preprocesado más agresivo para manuscritos antiguos.
- Puedes probar PSM 6, 11 o 4 según el tipo de página.
- Para máxima precisión en manuscrito complejo, sigue recomendado entrenar/usar HTR en Transkribus.

### Validacion cliente: manuscrito vs texto digital

La web incluye un validador en navegador para detectar de forma heuristica si una imagen parece texto impreso/digital (no manuscrito).

- Nucleo modular en `web/public/manuscript-validator.js` (preparado para agregar nuevos detectores).
- Integracion UI en `web/public/client.js`.

Puedes generar muestras y ejecutar pruebas locales:

```bash
cd ocr-pipeline/web
npm run samples:generate
npm run test:validator
```

Las muestras se guardan en `web/test_samples/`.

### Anti-bot opcional: chequeo de cara por camara

Se agrego un chequeo facial anti-bot en navegador con estas reglas:

- **Inactivo por defecto** para no bloquear el flujo normal.
- **Modo pruebas activo** por defecto con boton "Probar chequeo de cara" en la UI.
- Para exigirlo en envios reales, activa variable de entorno.

Variables:

```bash
# 0 = inactivo (default), 1 = activo en envios
export FACE_ANTIBOT_ENABLED=0

# 1 = muestra boton de pruebas (default), 0 = ocultarlo
export FACE_ANTIBOT_TEST_MODE=1

# secreto HMAC para firmar nonce+timestamp (obligatorio en produccion)
export FACE_ANTIBOT_SECRET='cambia-esto-en-produccion'

# validez del challenge firmado (ms), default 120000
export FACE_ANTIBOT_CHALLENGE_TTL_MS=120000
```

Ejemplo:

```bash
cd ocr-pipeline
FACE_ANTIBOT_ENABLED=0 FACE_ANTIBOT_TEST_MODE=1 bash run_web.sh
```

## Integracion con Transkribus (recomendado para manuscrito)

1. Sube `preprocessed/` a tu coleccion.
2. Prueba un modelo publico en espanol.
3. Corrige 30-50 paginas representativas.
4. Entrena modelo propio y reprocesa todo el lote.
5. Exporta TXT/ALTO/PDF buscable.

## Piloto OCR con Google Document AI (manuscritos)

Este repo incluye un piloto para evaluar **Enterprise Document OCR** de Document AI
contra el pipeline local actual.

### 1) Crear procesador OCR en Google Cloud

- Tipo recomendado: **OCR_ PROCESSOR** (Enterprise Document OCR).
- Region sugerida: `us` o `eu` (elige segun residencia de datos y latencia).

### 2) Credenciales

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/ruta/service-account.json"
```

### 3) Dependencia Python

```bash
pip install google-cloud-documentai
```

### 4) Ejecutar OCR de Document AI sobre tus imagenes

```bash
python3 scripts/docai_ocr.py \
  --input_dir raw \
  --output_dir ocr_docai \
  --project_id TU_PROJECT_ID \
  --location us \
  --processor_id TU_PROCESSOR_ID
```

Opcional: fijar version del procesador

```bash
python3 scripts/docai_ocr.py \
  --input_dir raw \
  --output_dir ocr_docai \
  --project_id TU_PROJECT_ID \
  --location us \
  --processor_id TU_PROCESSOR_ID \
  --processor_version_id TU_VERSION_ID
```

### 5) Comparar calidad con CER

Con tus transcripciones en `ground_truth/`:

```bash
python3 scripts/compute_cer.py --gt_dir ground_truth --ocr_dir ocr
python3 scripts/compute_cer.py --gt_dir ground_truth --ocr_dir ocr_docai
```

Compara promedio CER, latencia y coste por pagina para decidir adopcion.

