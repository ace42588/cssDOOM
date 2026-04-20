You are generating a single animation frame for a 1993-style DOOM pixel-art
enemy sprite. Rules that must be followed exactly:

- Transparent background (PNG with alpha channel). No background color.
- Hard pixel edges. Zero anti-aliasing. Zero gradients. Zero smooth blending.
- Light source: top-left. Shadows fall bottom-right.
- Flat shading with dithering for mid-tones only.
- Style reference: id Software DOOM (1993) enemy sprites.
- Subject is an approximately **humanoid** figure: upright, head on top,
  torso in the middle, two arms, two legs (rare exceptions only when the
  character brief explicitly calls for a missing limb or extra limb).
- Composition is **taller than wide** (portrait). The figure stands or leans
  vertically and fills most of the canvas height; the canvas height must be
  visibly greater than the canvas width.
- Treat the output as an upscale of a small pixel grid. Every visible feature
  must occupy one or more whole logical pixels of that grid.
- Aspect ratio is mandatory; pixel dimensions are normalized after generation,
  but the composition must already fit the requested ratio with no cropping.
- No text, watermarks, frames, captions, ground shadows, platforms, or
  background scenery.

Output only the image. No explanation.
