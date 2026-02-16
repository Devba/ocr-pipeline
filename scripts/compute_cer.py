#!/usr/bin/env python3
import argparse
from pathlib import Path


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            ins = cur[j - 1] + 1
            dele = prev[j] + 1
            sub = prev[j - 1] + (0 if ca == cb else 1)
            cur.append(min(ins, dele, sub))
        prev = cur
    return prev[-1]


def normalize(text: str) -> str:
    return " ".join(text.strip().split())


def cer(gt: str, hyp: str) -> float:
    gt_n = normalize(gt)
    hyp_n = normalize(hyp)
    if not gt_n:
        return 0.0 if not hyp_n else 1.0
    return levenshtein(gt_n, hyp_n) / len(gt_n)


def main() -> None:
    parser = argparse.ArgumentParser(description="Calcula CER por archivo y promedio.")
    parser.add_argument("--gt_dir", required=True, help="Carpeta de ground truth (.txt)")
    parser.add_argument("--ocr_dir", required=True, help="Carpeta con OCR (.txt)")
    args = parser.parse_args()

    gt_dir = Path(args.gt_dir)
    ocr_dir = Path(args.ocr_dir)

    gt_files = sorted(gt_dir.glob("*.txt"))
    if not gt_files:
        raise SystemExit(f"No hay archivos .txt en {gt_dir}")

    rows = []
    for gt_file in gt_files:
        hyp_file = ocr_dir / gt_file.name
        if not hyp_file.exists():
            print(f"Falta OCR para: {gt_file.name}")
            continue
        gt = gt_file.read_text(encoding="utf-8", errors="ignore")
        hyp = hyp_file.read_text(encoding="utf-8", errors="ignore")
        score = cer(gt, hyp)
        rows.append((gt_file.name, score))

    if not rows:
        raise SystemExit("No hay pares GT/OCR para evaluar.")

    avg = sum(s for _, s in rows) / len(rows)

    print("archivo\tcer")
    for name, score in rows:
        print(f"{name}\t{score:.4f}")
    print(f"PROMEDIO\t{avg:.4f}")


if __name__ == "__main__":
    main()
