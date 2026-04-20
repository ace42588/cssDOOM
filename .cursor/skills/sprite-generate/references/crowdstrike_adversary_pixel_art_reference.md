# CrowdStrike adversary pixel art reference

## Full reference table

| CrowdStrike adversary | Visual motif | Pixel art treatment | Suggested palette | DOOM-style role |
|---|---|---|---|---|
| **Fancy Bear** | Decorated military/aristocratic bear | Officer cap, medals, heavy shoulders, stern face | Navy, gold, red, brown | Elite hitscanner / commander |
| **Cozy Bear** | Quiet, heavy, concealed bear | Rounded bulk, hood or scarf, subdued posture | Brown, gray, muted blue | Ambush bruiser |
| **Voodoo Bear** | Occult / ritual bear | Totem mask, skull charms, stitched fur, glowing eyes | Purple, bone, black, dark red | Boss / summoner |
| **Venomous Bear** | Poisonous bear hybrid | Fangs, venom drip, serpent motifs, toxic claws | Green, black, yellow | Poison melee tank |
| **Charming Kitten** | Cute but deceptive cat | Large eyes, smug expression, concealed blade/claws | White, pink, black | Fast deceptive light enemy |
| **Hydro Kitten** | Water-themed cat | Droplets, slick fur, pipe or wave motifs | Cyan, blue, silver | Sliding skirmisher |
| **Static Kitten** | Electric / glitch cat | Jagged outline, spark arcs, scanline flicker | Yellow, blue, white | Shock attacker |
| **Spectral Kitten** | Ghostly cat | Transparent edges, aura, hollow eyes | Pale blue, gray, white | Stealth / phase enemy |
| **Cascade Panda** | Falling water panda | Vertical streaks, waterfall robe, flowing motion | Blue, white, dark gray | Mid-tier caster |
| **Hollow Panda** | Empty / skeletal panda | Negative-space face, rib-like markings | Black, bone, gray | Undead / cursed unit |
| **Overcast Panda** | Storm-cloud panda | Cloud shoulders, rain cape, thunder accents | Gray, slate, pale blue | Area denial attacker |
| **Vapor Panda** | Mist / smoke panda | Soft silhouette, drifting edges, respirator option | Teal, purple, gray | Obscuring support enemy |
| **Vertigo Panda** | Dizzy / spiral panda | Spiral eyes, off-axis stance, warped aura | Black, white, magenta | Disorientation / psychic role |
| **Golden Chollima** | Golden winged horse | Bright armored horse, wings, heroic silhouette | Gold, white, red | Flying charger / elite |
| **Stardust Chollima** | Celestial winged horse | Star particles, comet tail, glowing mane | Deep blue, gold, white | Fast aerial attacker |
| **Labyrinth Chollima** | Maze-themed horse | Maze lines on armor/wings, geometric faceplate | Bronze, stone, blue | Puzzle-boss / teleport unit |
| **Velvet Chollima** | Regal textile horse | Draped cloth barding, elegant but uncanny | Maroon, black, silver | High-status elite |
| **Ghost Jackal** | Spectral jackal | Lean canine, wispy tail, transparent paws | Cyan, gray, black | Fast flanker |
| **Bounty Jackal** | Hunter / outlaw jackal | Bandolier, hat, trophy tags | Brown, tan, brass | Ranged hunter |
| **Partisan Jackal** | Militant jackal | Improvised gear, scarf, aggressive posture | Olive, brown, red | Mid-tier assault unit |
| **Cruel Jackal** | Brutal feral jackal | Spikes, scars, oversized jaws | Dark brown, red, bone | Berserker melee |
| **Renegade Jackal** | Rogue jackal | Torn uniform, asymmetrical armor | Gray, rust, black | Agile raider |
| **Punk Spider** | Punk arachnid | Mohawk, studs, patched vest, hostile grin | Neon green, black, pink | Fodder swarmer |
| **Robot Spider** | Mech spider | Chrome limbs, optic eye, hard geometric body | Silver, red, gunmetal | Turret / tech enemy |
| **Sprite Spider** | Playful or fey spider | Exaggerated eyes, magical trail, stylized legs | Lavender, cyan, white | Trickster support |
| **Warlock Spider** | Sorcerer spider | Hood, runes, glowing abdomen sigils | Purple, black, emerald | Caster / projectile unit |
| **Revenant Spider** | Undead spider | Bone legs, hollow carapace, green eyes | Bone, black, sickly green | Undead elite |
| **Demon Spider** | Hellish spider | Horns, fiery abdomen, serrated limbs | Red, black, orange | Aggressive mid-boss |
| **Honey Spider** | Bee/hive spider hybrid | Honeycomb markings, dripping abdomen | Amber, brown, cream | Summoner / spawn unit |
| **Lightning Spider** | Storm spider | Forked leg highlights, crackling abdomen | Blue, yellow, white | Shock projectile unit |
| **Mutant Spider** | Grotesque spider | Extra eyes, asymmetrical limbs, exposed flesh | Flesh, green, black | Heavy grotesque bruiser |

## Notes for integration

Your current enemy sheets use combined-sheet layouts with 7 rows and per-state animation switching for walk, attack, and death. Existing enemy definitions include dimensions such as `POSS` at `48x55`, `SPOS` at `52x60`, `TROO` at `58x62`, `SARG` at `64x59`, and `BOSS` at `69x74`, which provides a practical scale ladder for mapping these adversary-inspired concepts into the current pipeline.

A practical mapping approach:

- Spider-based enemies on the POSS or TROO scale
- Jackal and Kitten designs on the SARG scale
- Bear and Chollima designs on the BOSS scale

## Source notes

This table is based on CrowdStrike adversary naming conventions and was organized specifically for pixel-art-oriented enemy design reference within this DOOM asset mod project.

