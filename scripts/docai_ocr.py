#!/usr/bin/env python3
import argparse
from pathlib import Path


MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".pdf": "application/pdf",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Ejecuta OCR con Google Document AI (Enterprise OCR) y guarda TXT por archivo."
        )
    )
    parser.add_argument("--input_dir", required=True, help="Carpeta con imágenes/PDF")
    parser.add_argument("--output_dir", required=True, help="Carpeta destino de TXT")
    parser.add_argument("--project_id", required=True, help="ID de proyecto GCP")
    parser.add_argument("--location", required=True, help="Región del procesador (ej: us, eu)")
    parser.add_argument("--processor_id", required=True, help="ID del processor OCR")
    parser.add_argument(
        "--processor_version_id",
        default="",
        help="ID de versión opcional (si se desea fijar versión)",
    )
    parser.add_argument(
        "--skip_existing",
        action="store_true",
        help="Omite archivos de salida ya existentes",
    )
    return parser.parse_args()


def get_mime(path: Path) -> str:
    ext = path.suffix.lower()
    mime = MIME_BY_EXT.get(ext)
    if not mime:
        raise ValueError(f"Extensión no soportada: {path.name}")
    return mime


def build_processor_name(client, project_id: str, location: str, processor_id: str, processor_version_id: str) -> str:
    if processor_version_id:
        return client.processor_version_path(
            project=project_id,
            location=location,
            processor=processor_id,
            processor_version=processor_version_id,
        )
    return client.processor_path(project=project_id, location=location, processor=processor_id)


def main() -> None:
    args = parse_args()

    try:
        from google.cloud import documentai
    except Exception as exc:
        raise SystemExit(
            "Falta dependencia google-cloud-documentai. Instala con: "
            "pip install google-cloud-documentai"
        ) from exc

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_dir.exists() or not input_dir.is_dir():
        raise SystemExit(f"input_dir no existe o no es carpeta: {input_dir}")

    client = documentai.DocumentProcessorServiceClient(
        client_options={"api_endpoint": f"{args.location}-documentai.googleapis.com"}
    )
    processor_name = build_processor_name(
        client=client,
        project_id=args.project_id,
        location=args.location,
        processor_id=args.processor_id,
        processor_version_id=args.processor_version_id,
    )

    candidates = sorted(
        p for p in input_dir.iterdir() if p.is_file() and p.suffix.lower() in MIME_BY_EXT
    )
    if not candidates:
        raise SystemExit(f"No hay archivos soportados en: {input_dir}")

    ok = 0
    failed = 0

    for source_path in candidates:
        target_path = output_dir / f"{source_path.stem}.txt"
        if args.skip_existing and target_path.exists():
            print(f"[SKIP] {source_path.name}")
            continue

        try:
            mime_type = get_mime(source_path)
            content = source_path.read_bytes()
            raw_document = documentai.RawDocument(content=content, mime_type=mime_type)
            request = documentai.ProcessRequest(name=processor_name, raw_document=raw_document)
            result = client.process_document(request=request)
            text = (result.document.text or "").strip()
            target_path.write_text(text + "\n", encoding="utf-8")
            print(f"[OK] {source_path.name} -> {target_path.name} ({len(text)} chars)")
            ok += 1
        except Exception as exc:
            print(f"[ERR] {source_path.name}: {exc}")
            failed += 1

    print(f"Completado. OK={ok} ERR={failed}")
    if ok == 0:
        raise SystemExit("Ningún archivo procesado correctamente.")


if __name__ == "__main__":
    main()
