---
description: Sprite sheet structure, CSS reference, and visual style constraints for the DOOM-style sprite pipeline.
globs: sprites/**
alwaysApply: false
---

# Sprite Sheet Context

## Sheet Structure (7 rows × 5 columns)
All cells share the same pixel dimensions. Cells with no frame content are fully transparent.

Row | Description                        | Frames | Columns used
----|------------------------------------|--------|-------------
 1  | Walk — facing viewer (0°)          | 2      | C1, C2
 2  | Walk — left oblique (45°)          | 2      | C1, C2
 3  | Walk — facing viewer's left (90°)  | 2      | C1, C2
 4  | Walk — away-left oblique (135°)    | 2      | C1, C2
 5  | Walk — facing away (180°)          | 2      | C1, C2
 6  | Attack — facing viewer (0°)        | 2      | C1, C2
 7  | Death — facing viewer (0°)         | 5      | C1–C5

- Rows 2, 3, 4: character faces screen-LEFT. Engine mirrors for right angles.
- Columns 3–5 in rows 1–6 are transparent/unused.
- Cell origin formula: x = (col - 1) × CELL_W,  y = (row - 1) × CELL_H

## CSS Reference
```css
.sprite[data-type="{{name}}"] {
  background-image: url('/assets/sprites/sheets/{{NAME}}.png');
  --w: {W}; --h: {H}; --cols: 5; --frames: 2; --rows: 7;
}
```
`--w` and `--h` are cell dimensions. `--cols` is always 5. JS sets `--frames` when switching states.

## Visual Style Constraints
- Pixel art; hard edges, no anti-aliasing
- Light source: top-left; shadows fall bottom-right
- Flat shading with dithering for mid-tones; no smooth blending
- Transparent PNG background (alpha channel)
- Style, palette, and proportions must be consistent across all cells

## File Conventions
- Cell files:      sprites/cells/{{NAME}}_R{row}_C{col}.png
- Sheet output:    sprites/sheets/{{NAME}}.png
- Sprite names:    4-character uppercase (DOOM convention, e.g. POSS, RBSP)