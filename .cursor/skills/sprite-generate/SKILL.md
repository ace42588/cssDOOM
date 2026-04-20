---
name: sprite-generate
description: Generates a complete DOOM-style enemy sprite, from written design
  specification through to individual cell images and final assembled sheet.
  Invoke when the user wants to create or generate a new sprite character.
---

# /sprite-generate

End-to-end workflow for creating a new DOOM-style enemy sprite. The agent
executes all scripts directly. The user is never asked to run a command.

Use the **repository workspace root** as the working directory for paths like
`sprites/{{NAME}}/...` and when invoking the scripts below:

- `bash .cursor/skills/sprite-generate/scripts/create-new-sprite.sh {{NAME}}`
- `python .cursor/skills/sprite-generate/scripts/assemble_sprite.py ...`

## Setup

Read these files before doing anything else:
- `assets/CHARACTER_BRIEF_TEMPLATE.md`   — basis for Phase A, Step 3
- `assets/USER_PROMPT_TEMPLATE.md`     — basis for Phase A, Step 5
- `references/SYSTEM_PROMPT.md`         — reproduced verbatim in Phase A, Step 5 and Phase B

## Input

The user must provide:
- A character concept or description

And optionally provide:
- A 4-character uppercase sprite name (DOOM convention, e.g. RBSP, POSS)

If the name is missing, create a reasonable 4-character, uppercase sprite name before proceeding.

---

## Phase A — Design Specification

### Step 1 — Scaffold the workspace
Run `bash .cursor/skills/sprite-generate/scripts/create-new-sprite.sh {{NAME}}`.
This creates `sprites/{{NAME}}/` with `cells/`, `sheets/`, and a blank `SPEC.md`.
All subsequent output is written into this directory.

### Step 2 — Cell Aspect Ratio
Pick a **portrait** aspect ratio for the cell (taller than wide). The exact
pixel size does not matter; only the ratio drives the prompt and the
character's proportions. A more imposing character can use a more elongated
ratio.

Output:
- Aspect ratio as `W:H` (e.g. `4:5`, `5:7`, `3:5`) with H > W.
- Decimal form (e.g. `0.80:1`).
- A short justification tying the ratio to the character's role.

For the scripts that need concrete pixels (`normalize_cell.py`,
`assemble_sprite.py`), pick any small integers that match the chosen ratio
(e.g. ratio `4:5` → `CELL_W = 64`, `CELL_H = 80`). Label those values
`CELL_W` and `CELL_H` and reuse them in Steps 7a, 8a, 9a, and 10. They are
implementation detail — never used as a constraint in the image prompt.

### Step 3 — Character Design Brief
Produce a completed version of `assets/CHARACTER_BRIEF_TEMPLATE.md`.
The brief must be fully self-contained — the image generation tool will have
no other context. Every color must include an approximate hex code.

### Step 4 — Per-Cell Pose Descriptions
For each of the 17 populated cells, output:

  FILE:  {{NAME}}_R{row}_C{col}.png
  POSE:  Body position, limb placement, weight shift.
  NOTES: Frame-specific details (muzzle flash, glow state, blood, tilt).

List in this exact order:
  R1C1, R1C2, R2C1, R2C2, R3C1, R3C2, R4C1, R4C2,
  R5C1, R5C2, R6C1, R6C2, R7C1, R7C2, R7C3, R7C4, R7C5

Rules:
- Flag R1C1 in its NOTES as the canonical design reference. All other cells
  must match its palette and proportions exactly.
- Rows 2, 3, 4: character faces screen-LEFT (engine mirrors for right angles).
- Do not write pose descriptions for columns 3–5 in rows 1–6 (transparent).

### Step 5 — Image Generation Prompts

SYSTEM PROMPT
  Reproduce `references/SYSTEM_PROMPT.md` verbatim. Do not modify it.

USER PROMPT TEMPLATE
  Produce a completed version of `assets/USER_PROMPT_TEMPLATE.md` with the
  aspect ratio (`W:H` and decimal form) from Step 2 and the palette summary
  from Step 3 filled in. Leave FILE, POSE, and NOTES as bracketed placeholders.
  Do not paste raw `CELL_W`/`CELL_H` pixel numbers into the image prompt — the
  prompt only specifies the ratio.

### Step 6 — Write the spec
Write Steps 2–5 above to `sprites/{{NAME}}/SPEC.md`.
Confirm the file has been written before proceeding to Phase B.

---

## Phase B — Cell Image Generation

### Image tool rules (Phase B)

- Use **only** Cursor's built-in agent image generation. Do not call external
  image APIs, image-generation CLIs, or other non-Cursor image tools.
- **One image per cell** — never combine multiple frames in a single generation.
- Reproduce `references/SYSTEM_PROMPT.md` **verbatim** in every image prompt;
  do not paraphrase or shorten it.
- The built-in image tool will not honor exact pixel dimensions from text. The
  prompt only controls **aspect ratio** and **pixel-grid look**; exact
  `CELL_W × CELL_H` is enforced by `scripts/normalize_cell.py` (see normalize
  steps below).
- Treat the raw output from the image tool as a temporary file. The canonical
  cell on disk under `sprites/{{NAME}}/cells/{{NAME}}_R{row}_C{col}.png` must
  always be the **normalized** result, never the raw generation.

### Palette argument

Build a single comma-separated `#RRGGBB` string from the brief's palette table
(Step 3) and reuse it for every normalize call in Steps 7a / 8a / 9a. Call this
value `{PALETTE_CSV}`, e.g. `#3a2a1f,#7b5a3c,#c8a86b,#1a1a1a,#ff2a2a`.

### Step 7 — Generate the canonical reference cell
Construct the image prompt for R1C1:
- Use the SYSTEM PROMPT from Step 5 (verbatim from `references/SYSTEM_PROMPT.md`)
- Fill FILE, POSE, and NOTES into the USER PROMPT TEMPLATE using the R1C1
  entry from Step 4

Generate the image with Cursor's built-in image generation. Save the raw output
to a temporary path, e.g. `sprites/{{NAME}}/cells/_raw_R1_C1.png`.

### Step 7a — Normalize R1C1
Run:

  python .cursor/skills/sprite-generate/scripts/normalize_cell.py \
    --in  sprites/{{NAME}}/cells/_raw_R1_C1.png \
    --out sprites/{{NAME}}/cells/{{NAME}}_R1_C1.png \
    --w {CELL_W} \
    --h {CELL_H} \
    --palette '{PALETTE_CSV}'

Delete the `_raw_R1_C1.png` file after a successful normalize. Present the
normalized `{{NAME}}_R1_C1.png` inline and ask the user to approve or provide
feedback.

If the user requests changes:
- Note the feedback
- Regenerate R1C1 using the original spec plus the feedback
- Re-run Step 7a (normalize) to overwrite the canonical file
- Present again
- Repeat until the user explicitly approves
- Do not proceed to Step 8 until R1C1 is approved

### Step 8 — Generate the remaining 16 cells
For each remaining cell in this order:
  R1C2, R2C1, R2C2, R3C1, R3C2, R4C1, R4C2,
  R5C1, R5C2, R6C1, R6C2, R7C1, R7C2, R7C3, R7C4, R7C5

For each cell:
1. Fill FILE, POSE, and NOTES into the USER PROMPT TEMPLATE
2. **Attach** `sprites/{{NAME}}/cells/{{NAME}}_R1_C1.png` as the reference image
   in the built-in image tool (the user-approved canonical cell), not only as text.
3. Append to the user prompt: "Match the approved R1C1 reference exactly
   for palette, proportions, and pixel style."
4. Generate **one** image with Cursor's built-in image generation, saving raw
   output to `sprites/{{NAME}}/cells/_raw_R{row}_C{col}.png`.
5. **Step 8a — Normalize the cell:**

       python .cursor/skills/sprite-generate/scripts/normalize_cell.py \
         --in  sprites/{{NAME}}/cells/_raw_R{row}_C{col}.png \
         --out sprites/{{NAME}}/cells/{{NAME}}_R{row}_C{col}.png \
         --w {CELL_W} \
         --h {CELL_H} \
         --palette '{PALETTE_CSV}'

   Delete the `_raw_*` file after a successful normalize.
6. Present the normalized `{{NAME}}_R{row}_C{col}.png` inline.

After all 16 are generated and normalized, present a summary list of all
output paths and ask the user to flag any cells that need regeneration before
assembly.

### Step 9 — Regeneration (if needed)
For each flagged cell:
- Accept a description of what is wrong
- Regenerate using the original spec, the approved R1C1 file (attach
  `sprites/{{NAME}}/cells/{{NAME}}_R1_C1.png` as the reference image when using
  the built-in tool), and the feedback in the text prompt. Save the raw output
  to `sprites/{{NAME}}/cells/_raw_R{row}_C{col}.png`.
- **Step 9a — Re-run normalize** to overwrite the canonical cell file:

      python .cursor/skills/sprite-generate/scripts/normalize_cell.py \
        --in  sprites/{{NAME}}/cells/_raw_R{row}_C{col}.png \
        --out sprites/{{NAME}}/cells/{{NAME}}_R{row}_C{col}.png \
        --w {CELL_W} \
        --h {CELL_H} \
        --palette '{PALETTE_CSV}'

  Delete the `_raw_*` file after a successful normalize.
- Present the normalized result and repeat until the user is satisfied.

### Step 10 — Assemble the sheet
Once all cells are approved, run:

  python .cursor/skills/sprite-generate/scripts/assemble_sprite.py \
    --cells-dir sprites/{{NAME}}/cells \
    --out-dir sprites/{{NAME}}/sheets \
    --name {{NAME}} \
    --w {CELL_W} \
    --h {CELL_H}

The assembled sheet will be written to `sprites/{{NAME}}/sheets/{{NAME}}.png`.
Present the output path to the user.