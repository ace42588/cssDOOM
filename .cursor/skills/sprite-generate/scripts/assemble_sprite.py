#!/usr/bin/env python3
"""
Sprite sheet assembler.
Tiles 17 individual cell PNGs into a single 7-row × 5-col sprite sheet.

Usage:
  python assemble_sprite.py --name RBSP --w 64 --h 62
  python assemble_sprite.py --cells-dir sprites/RBSP/cells \\
    --out-dir sprites/RBSP/sheets --name RBSP --w 64 --h 62
"""

import argparse
import sys
from pathlib import Path
from PIL import Image

# Grid definition: (row, col) for every populated cell.
POPULATED_CELLS = [
    (1,1),(1,2),
    (2,1),(2,2),
    (3,1),(3,2),
    (4,1),(4,2),
    (5,1),(5,2),
    (6,1),(6,2),
    (7,1),(7,2),(7,3),(7,4),(7,5),
]

TOTAL_ROWS = 7
TOTAL_COLS = 5

SCRIPT_DIR = Path(__file__).parent
DEFAULT_CELLS_DIR = SCRIPT_DIR / "cells"
DEFAULT_OUT_DIR = SCRIPT_DIR / "sheets"

def expected_filename(name: str, row: int, col: int) -> str:
    return f"{name}_R{row}_C{col}.png"


def validate_inputs(cell_dir: Path, name: str) -> list[str]:
    """Check all 17 expected files exist. Return list of missing filenames."""
    missing = []
    for row, col in POPULATED_CELLS:
        fname = expected_filename(name, row, col)
        if not (cell_dir / fname).exists():
            missing.append(fname)
    return missing


def assemble(
    cell_dir: Path, name: str, cell_w: int, cell_h: int, out_dir: Path
) -> Path:
    sheet_w = cell_w * TOTAL_COLS
    sheet_h = cell_h * TOTAL_ROWS

    # Create fully transparent sheet
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

    for row, col in POPULATED_CELLS:
        fname = expected_filename(name, row, col)
        cell_path = cell_dir / fname

        cell_img = Image.open(cell_path).convert("RGBA")

        # Warn if cell dimensions don't match spec
        if cell_img.size != (cell_w, cell_h):
            print(
                f"  WARNING: {fname} is {cell_img.size}, "
                f"expected ({cell_w}, {cell_h}). Resizing with NEAREST."
            )
            cell_img = cell_img.resize((cell_w, cell_h), Image.NEAREST)

        # Cell origin: 0-indexed
        x = (col - 1) * cell_w
        y = (row - 1) * cell_h

        # Paste using alpha mask to preserve transparency
        sheet.paste(cell_img, (x, y), mask=cell_img)

        print(f"  Placed {fname} at ({x}, {y})")

    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / f"{name}.png"
    sheet.save(output_path, format="PNG")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Assemble DOOM sprite sheet from cells.")
    parser.add_argument("--name", required=True, help="Sprite name prefix (e.g. RBSP)")
    parser.add_argument("--w", required=True, type=int, help="Cell width in pixels")
    parser.add_argument("--h", required=True, type=int, help="Cell height in pixels")
    parser.add_argument(
        "--cells-dir",
        type=Path,
        default=None,
        help=f"Directory with cell PNGs (default: {DEFAULT_CELLS_DIR})",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help=f"Directory for output sheet (default: {DEFAULT_OUT_DIR})",
    )
    args = parser.parse_args()

    cell_dir = args.cells_dir or DEFAULT_CELLS_DIR
    out_dir = args.out_dir or DEFAULT_OUT_DIR
    if not cell_dir.is_dir():
        print(f"ERROR: Directory not found: {cell_dir}")
        sys.exit(1)

    print(f"\nValidating 17 expected cell files in: {cell_dir}")
    missing = validate_inputs(cell_dir, args.name)
    if missing:
        print(f"\nERROR: {len(missing)} file(s) missing:")
        for f in missing:
            print(f"  - {f}")
        print("\nAborting. Generate all cells before assembling.")
        sys.exit(1)

    print("All 17 cells found. Assembling sheet...\n")

    output_path = assemble(cell_dir, args.name, args.w, args.h, out_dir)
    sheet_w = args.w * TOTAL_COLS
    sheet_h = args.h * TOTAL_ROWS

    print(f"\nDone.")
    print(f"  Output : {output_path}")
    print(f"  Size   : {sheet_w} × {sheet_h} px  ({TOTAL_COLS} cols × {TOTAL_ROWS} rows)")
    print(f"  Cell   : {args.w} × {args.h} px")


if __name__ == "__main__":
    main()