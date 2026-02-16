#!/usr/bin/env python3
from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "test_samples"
OUT_DIR.mkdir(parents=True, exist_ok=True)

W, H = 1300, 900


def get_font(size: int):
    for candidate in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ]:
        p = Path(candidate)
        if p.exists():
            return ImageFont.truetype(str(p), size=size)
    return ImageFont.load_default()


def draw_printed(path: Path, seed: int):
    random.seed(seed)
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    font = get_font(30)

    lines = [
        "ARCHIVO GENERAL DEL MUNICIPIO",
        "ACTA DE RECEPCION DE INVENTARIO",
        "En cumplimiento del protocolo establecido,",
        "se certifica la recepcion de bienes.",
        "Firmado y sellado por la autoridad competente.",
        "Fecha: 14 de mayo de 1962",
    ]

    y = 90
    for line in lines:
        x = 90
        draw.text((x, y), line, fill=(20, 20, 20), font=font)
        y += 68

    img.save(path)


def draw_handwritten_like(path: Path, seed: int):
    random.seed(seed)
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    font = get_font(34)

    words = [
        "Querida", "memoria", "de", "la", "casa", "antigua", "hoy", "vuelvo", "a", "contar",
        "las", "historias", "que", "quedaron", "guardadas", "entre", "papeles", "y", "cartas",
    ]

    y = 110
    for _ in range(10):
        x = 85 + random.randint(-25, 20)
        baseline_jitter = random.randint(-12, 12)
        line = " ".join(random.choices(words, k=random.randint(6, 10)))
        draw.text((x, y + baseline_jitter), line, fill=(25, 25, 25), font=font)

        line_width = max(100, int(0.75 * len(line) * 16))
        wave_y = y + 45 + random.randint(-8, 8)
        for sx in range(x, min(W - 40, x + line_width), 16):
            ey = wave_y + random.randint(-3, 3)
            draw.line((sx, wave_y, sx + 12, ey), fill=(40, 40, 40), width=1)
            wave_y = ey

        y += random.randint(58, 84)

    img.save(path)


def draw_mixed(path: Path):
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    font_print = get_font(30)
    font_hand = get_font(34)

    draw.text((95, 95), "REGISTRO OFICIAL DE TRANSFERENCIAS", fill=(20, 20, 20), font=font_print)
    draw.text((95, 170), "Nro de expediente: 442-A", fill=(20, 20, 20), font=font_print)

    y = 300
    snippets = [
        "notas al margen con letra variable",
        "apunte rapido de quien revisa",
        "firma provisional y comentario",
    ]
    for text in snippets:
        x = 120 + random.randint(-20, 25)
        draw.text((x, y + random.randint(-10, 10)), text, fill=(25, 25, 25), font=font_hand)
        y += 95

    img.save(path)


def main():
    draw_printed(OUT_DIR / "printed_1.png", seed=11)
    draw_printed(OUT_DIR / "printed_2.png", seed=22)
    draw_handwritten_like(OUT_DIR / "hand_1.png", seed=33)
    draw_handwritten_like(OUT_DIR / "hand_2.png", seed=44)
    draw_mixed(OUT_DIR / "mixed_1.png")
    print(f"Generated samples in: {OUT_DIR}")


if __name__ == "__main__":
    main()
