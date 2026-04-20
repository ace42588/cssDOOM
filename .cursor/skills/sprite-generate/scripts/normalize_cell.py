#!/usr/bin/env python3
"""
Normalize a generated sprite cell to exact pixel dimensions and (optionally) a
fixed palette. Use after each Cursor image-tool generation, before saving the
canonical cell file under sprites/{NAME}/cells/.

Pipeline:
  1. Load image, force RGBA.
  2. Snap near-transparent pixels to fully transparent (alpha threshold).
  3. Crop to the opaque bounding box (drops empty margins the model added).
  4. Letterbox into a target-aspect canvas (preserves proportions).
  5. NEAREST resample to exactly W x H.
  6. Optionally quantize all opaque pixels to the nearest palette color.
  7. Write PNG (RGBA) to --out.

Usage:
  python normalize_cell.py --in raw.png --out RBSP_R1_C1.png --w 64 --h 62
  python normalize_cell.py --in raw.png --out RBSP_R1_C1.png \\
      --w 64 --h 62 --palette '#3a2a1f,#7b5a3c,#c8a86b,#1a1a1a,#ff2a2a'
"""

import argparse
import sys
from pathlib import Path
from PIL import Image

ALPHA_CUTOFF = 16  # alpha < this => fully transparent (kills AA halos)


def parse_palette(s: str) -> list[tuple[int, int, int]]:
    out = []
    for raw in s.split(","):
        h = raw.strip().lstrip("#")
        if len(h) != 6:
            raise ValueError(f"Bad palette entry (need #RRGGBB): {raw!r}")
        out.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    if not out:
        raise ValueError("Empty palette")
    return out


def snap_alpha(img: Image.Image, cutoff: int) -> Image.Image:
    r, g, b, a = img.split()
    a = a.point(lambda v: 0 if v < cutoff else (255 if v > 255 - cutoff else v))
    return Image.merge("RGBA", (r, g, b, a))


def crop_to_alpha(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def fit_to_aspect(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Scale-then-letterbox into a canvas with the target aspect, on the
    same logical pixel scale as the source — so subsequent NEAREST downsample
    keeps blocks square."""
    src_w, src_h = img.size
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h

    if abs(src_ratio - target_ratio) < 1e-6:
        return img

    if src_ratio > target_ratio:
        # source is too wide: pad top/bottom
        new_h = round(src_w / target_ratio)
        canvas = Image.new("RGBA", (src_w, new_h), (0, 0, 0, 0))
        offset = ((0, (new_h - src_h) // 2))
    else:
        # source is too tall: pad left/right
        new_w = round(src_h * target_ratio)
        canvas = Image.new("RGBA", (new_w, src_h), (0, 0, 0, 0))
        offset = (((new_w - src_w) // 2, 0))

    canvas.paste(img, offset, img)
    return canvas


def quantize_to_palette(
    img: Image.Image, palette: list[tuple[int, int, int]]
) -> Image.Image:
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            best = min(
                palette,
                key=lambda c: (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2,
            )
            px[x, y] = (best[0], best[1], best[2], a)
    return img


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="in_path", required=True, type=Path)
    p.add_argument("--out", dest="out_path", required=True, type=Path)
    p.add_argument("--w", required=True, type=int, help="Target cell width (px)")
    p.add_argument("--h", required=True, type=int, help="Target cell height (px)")
    p.add_argument(
        "--palette",
        default=None,
        help="Optional comma-separated #RRGGBB list to quantize opaque pixels.",
    )
    p.add_argument(
        "--alpha-cutoff",
        type=int,
        default=ALPHA_CUTOFF,
        help=f"Snap alpha below this to 0 (default: {ALPHA_CUTOFF}).",
    )
    args = p.parse_args()

    if not args.in_path.is_file():
        print(f"ERROR: input not found: {args.in_path}", file=sys.stderr)
        return 1

    img = Image.open(args.in_path).convert("RGBA")
    print(f"  in : {args.in_path}  size={img.size}")

    img = snap_alpha(img, args.alpha_cutoff)
    img = crop_to_alpha(img)
    if img.size == (0, 0):
        print("ERROR: image is fully transparent after alpha snap.", file=sys.stderr)
        return 1
    print(f"  cropped to opaque bbox: size={img.size}")

    img = fit_to_aspect(img, args.w, args.h)
    print(f"  letterboxed to aspect {args.w}:{args.h}: size={img.size}")

    img = img.resize((args.w, args.h), Image.NEAREST)
    print(f"  resampled NEAREST -> {img.size}")

    if args.palette:
        palette = parse_palette(args.palette)
        img = quantize_to_palette(img, palette)
        print(f"  quantized to {len(palette)}-color palette")

    args.out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out_path, format="PNG")
    print(f"  out: {args.out_path}  size={img.size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
