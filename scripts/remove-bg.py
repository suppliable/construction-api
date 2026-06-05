#!/usr/bin/env python3
"""
Remove backgrounds from product images and export app-ready versions.

Usage:
  python3 scripts/remove-bg.py <input_folder> [output_folder]

Walks subfolders recursively, mirrors the folder structure in output.
Skips images that have already been processed (output files exist).

Output per image:
  - <name>.png        — transparent background, 1000x1000
  - <name>.webp       — transparent background, smaller (app-ready)
  - <name>_white.jpg  — white background, for thumbnails / previews

Supported input formats: jpg, jpeg, jfif, jpe, png, webp
"""

import sys
import io
from pathlib import Path
from PIL import Image
from rembg import remove

SUPPORTED = {'.jpg', '.jpeg', '.png', '.webp', '.jfif', '.jpe'}
TARGET_SIZE = (1000, 1000)


def pad_to_square(img: Image.Image) -> Image.Image:
    img.thumbnail(TARGET_SIZE, Image.LANCZOS)
    canvas = Image.new('RGBA', TARGET_SIZE, (255, 255, 255, 0))
    offset = ((TARGET_SIZE[0] - img.width) // 2, (TARGET_SIZE[1] - img.height) // 2)
    canvas.paste(img, offset, img if img.mode == 'RGBA' else None)
    return canvas


def white_bg(img: Image.Image) -> Image.Image:
    bg = Image.new('RGB', img.size, (255, 255, 255))
    if img.mode == 'RGBA':
        bg.paste(img, mask=img.split()[3])
    else:
        bg.paste(img)
    return bg


def process(input_path: Path, output_dir: Path):
    stem = input_path.stem
    png_path  = output_dir / f"{stem}.png"
    webp_path = output_dir / f"{stem}.webp"
    jpg_path  = output_dir / f"{stem}_white.jpg"

    # Skip if all outputs already exist
    if png_path.exists() and webp_path.exists() and jpg_path.exists():
        print(f"  SKIP (already done): {input_path.name}")
        return

    print(f"  Processing: {input_path.name}", end='', flush=True)
    try:
        raw = input_path.read_bytes()
        removed = remove(raw)

        img = Image.open(io.BytesIO(removed)).convert('RGBA')
        square = pad_to_square(img)

        square.save(png_path, 'PNG', optimize=True)
        square.save(webp_path, 'WEBP', quality=85, method=6)
        white_bg(square).save(jpg_path, 'JPEG', quality=90, optimize=True)

        png_kb  = png_path.stat().st_size // 1024
        webp_kb = webp_path.stat().st_size // 1024
        jpg_kb  = jpg_path.stat().st_size // 1024
        print(f" ✅  PNG:{png_kb}KB  WebP:{webp_kb}KB  JPG:{jpg_kb}KB")

    except Exception as e:
        print(f" ❌  {e}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    input_root = Path(sys.argv[1]).expanduser().resolve()
    output_root = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 \
        else input_root.parent / (input_root.name + '_processed')

    if not input_root.is_dir():
        print(f"Error: '{input_root}' is not a directory.")
        sys.exit(1)

    # Collect all images recursively
    images = sorted([p for p in input_root.rglob('*') if p.suffix.lower() in SUPPORTED])

    if not images:
        print(f"No supported images found in {input_root}")
        sys.exit(1)

    print(f"Input  : {input_root}")
    print(f"Output : {output_root}")
    print(f"Images : {len(images)} found across all subfolders")
    print()

    done, skipped, failed = 0, 0, 0
    for img_path in images:
        # Mirror subfolder structure in output
        rel = img_path.parent.relative_to(input_root)
        out_dir = output_root / rel
        out_dir.mkdir(parents=True, exist_ok=True)

        stem = img_path.stem
        if all((out_dir / f"{stem}{ext}").exists() for ext in ['.png', '.webp', '_white.jpg']):
            print(f"  SKIP: {rel / img_path.name}")
            skipped += 1
            continue

        print(f"  [{done+skipped+failed+1}/{len(images)}] {rel / img_path.name}", end='', flush=True)
        try:
            raw = img_path.read_bytes()
            removed = remove(raw)
            img = Image.open(io.BytesIO(removed)).convert('RGBA')
            square = pad_to_square(img)

            square.save(out_dir / f"{stem}.png", 'PNG', optimize=True)
            square.save(out_dir / f"{stem}.webp", 'WEBP', quality=85, method=6)
            white_bg(square).save(out_dir / f"{stem}_white.jpg", 'JPEG', quality=90, optimize=True)

            kb = lambda p: (out_dir / p).stat().st_size // 1024
            print(f" ✅  PNG:{kb(stem+'.png')}KB  WebP:{kb(stem+'.webp')}KB  JPG:{kb(stem+'_white.jpg')}KB")
            done += 1
        except Exception as e:
            print(f" ❌  {e}")
            failed += 1

    print()
    print(f"═" * 50)
    print(f"Done   : {done}")
    print(f"Skipped: {skipped} (already processed)")
    print(f"Failed : {failed}")
    print(f"Output : {output_root}")


if __name__ == '__main__':
    main()
