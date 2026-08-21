#!/usr/bin/env python3
"""Regenerate src-tauri/icons/Spike.icon from the master icon.

The Spike mark only exists as raster art (src-tauri/icons/icon.icns), so the
glyph is recovered from the 1024px representation rather than drawn from a
vector source. Two facts about that source drive the extraction:

  - the tile is a rounded rect inset to 824px of the 1024 canvas, with a soft
    drop shadow baked into the alpha below it, and
  - the tile carries a light rim stroke at its edge that is bright enough
    (~128) to be mistaken for glyph pixels, so the glyph mask is intersected
    with an eroded copy of the tile to cut the rim away.

Icon Composer draws its own material, mask and shadow, so what ships in the
.icon bundle is just the glyph on a full-bleed transparent canvas. Light and
dark fills live in icon.json as appearance specializations.

    python3 scripts/gen-app-icon.py

Run scripts/apply-app-icon.sh after this to compile and inject the result.
"""

import json
import pathlib
import shutil
import subprocess
import tempfile

from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICNS = ROOT / "src-tauri/icons/icon.icns"
DEST = ROOT / "src-tauri/icons/Spike.icon"

N = 1024
TILE_INSET = 100          # tile occupies 100..923 of the 1024 canvas
SHADOW_CEIL = 62          # max alpha of the baked drop shadow
RIM_ERODE = 25            # MinFilter window; must exceed the rim stroke width

# The tile is inset to 824px but Icon Composer masks the full 1024 canvas, so
# the glyph is scaled up to keep its optical size inside the final rounded rect.
FULL_BLEED_SCALE = N / (N - 2 * TILE_INSET)


def source_1024() -> Image.Image:
    """Pull the 1024px representation out of the master icns."""
    with tempfile.TemporaryDirectory() as tmp:
        iconset = pathlib.Path(tmp) / "icon.iconset"
        subprocess.run(
            ["iconutil", "--convert", "iconset", "--output", str(iconset), str(ICNS)],
            check=True,
        )
        return Image.open(iconset / "icon_512x512@2x.png").convert("RGBA")


def glyph_mask(src: Image.Image) -> Image.Image:
    """Recover the glyph as an alpha mask, free of tile and rim."""
    px = src.load()
    alpha = src.split()[3]

    # Drop the baked drop shadow so only the solid tile survives.
    tile = alpha.point(
        lambda a: max(0, min(255, (a - (SHADOW_CEIL + 38)) * 255 // (255 - SHADOW_CEIL - 38)))
    )

    # The glyph is the bright content inside the tile. Remap 64..240 to 0..255:
    # the tile gradient tops out around 56, the glyph sits at 255.
    mask = Image.new("L", (N, N), 0)
    mp = mask.load()
    for y in range(N):
        for x in range(N):
            r, g, b, a = px[x, y]
            if a < 8:
                continue
            lum = (r * 299 + g * 587 + b * 114) // 1000
            mp[x, y] = max(0, min(255, (lum - 64) * 255 // 176)) * a // 255

    # Intersect with an eroded tile to remove the rim stroke, which is bright
    # enough at the top edge to survive the luminance remap above.
    inner = tile.filter(ImageFilter.MinFilter(RIM_ERODE))
    ip = inner.load()
    for y in range(N):
        for x in range(N):
            if mp[x, y]:
                mp[x, y] = mp[x, y] * ip[x, y] // 255
    return mask


def full_bleed(mask: Image.Image) -> Image.Image:
    """Scale the glyph from the inset tile grid onto the full 1024 canvas."""
    big = mask.resize(
        (round(N * FULL_BLEED_SCALE), round(N * FULL_BLEED_SCALE)), Image.LANCZOS
    )
    off = (N - big.width) // 2
    canvas = Image.new("L", (N, N), 0)
    canvas.paste(big, (off, off))

    out = Image.new("RGBA", (N, N), (255, 255, 255, 0))
    out.putalpha(canvas)
    return out


# The Dock mark is black in every appearance: a near-black tile with an
# off-white glyph, no light/dark specialization. The earlier appearance-aware
# icon rendered a washed light-grey tile with a silver-bevel glyph in macOS
# light mode, which read as "not black" — the mark is meant to stay black
# regardless of system appearance.
#
# Off-white glyph (0.9020), NOT pure white. Pure 1.0 blooms against the dark
# tile (irradiation) and reads soft in the Dock; ~0.90 keeps the mark crisp
# without visibly greying it.
ICON_JSON = {
    "fill": {"automatic-gradient": "extended-srgb:0.1216,0.1216,0.1216,1.0"},
    "groups": [
        {
            "layers": [
                {
                    "image-name": "glyph.png",
                    "name": "Spike",
                    "fill": {"solid": "extended-srgb:0.9020,0.9020,0.9020,1.0"},
                }
            ]
        }
    ],
    "supported-platforms": {"circles": ["watchOS"], "squares": "shared"},
}


def main() -> None:
    src = source_1024()
    glyph = full_bleed(glyph_mask(src))

    if DEST.exists():
        shutil.rmtree(DEST)
    (DEST / "Assets").mkdir(parents=True)
    glyph.save(DEST / "Assets/glyph.png")
    (DEST / "icon.json").write_text(json.dumps(ICON_JSON, indent=2) + "\n")

    print(f"glyph bounds {glyph.split()[3].getbbox()} on {N}x{N}")
    print(f"wrote {DEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
