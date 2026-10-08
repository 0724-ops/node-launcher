"""生成 Node Launcher 的应用图标（build/icon.ico + build/icon.png）。

用法： python scripts/make-icon.py
依赖： Pillow（DSH 内置运行时已提供）
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "build")

# 与界面主题一致
BG_TOP = (18, 21, 27)
BG_BOTTOM = (13, 15, 18)
ACCENT = (79, 140, 255)
PURPLE = (163, 123, 255)
GREEN = (53, 192, 122)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make_master(size: int = 512) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(size * 0.22)
    # 背景：垂直渐变 + 圆角
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(
            int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        ) + (255,)
        gdraw.line([(0, y), (size, y)], fill=color)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 描边
    draw.rounded_rectangle(
        [1, 1, size - 2, size - 2],
        radius,
        outline=(60, 66, 80, 255),
        width=max(2, size // 160),
    )

    # 主体：大号 "N"（Node）
    font = load_font(int(size * 0.52))
    text = "N"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - th) / 2 - bbox[1] - int(size * 0.04)

    # 渐变字：用遮罩叠加
    text_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(text_mask).text((tx, ty), text, font=font, fill=255)
    grad_text = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gt = ImageDraw.Draw(grad_text)
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(int(ACCENT[i] + (PURPLE[i] - ACCENT[i]) * t) for i in range(3)) + (255,)
        gt.line([(0, y), (size, y)], fill=color)
    img.paste(grad_text, (0, 0), text_mask)

    # 右下角播放三角（启动）
    tri = [
        (int(size * 0.63), int(size * 0.635)),
        (int(size * 0.63), int(size * 0.855)),
        (int(size * 0.83), int(size * 0.745)),
    ]
    draw.polygon(tri, fill=GREEN)

    return img


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    master = make_master(512)

    png_path = os.path.join(OUT_DIR, "icon.png")
    master.save(png_path, "PNG")
    print(f"wrote {png_path}")

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    master.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {ico_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
