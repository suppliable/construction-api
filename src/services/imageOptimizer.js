'use strict';

/**
 * Re-encodes uploaded images to WebP at a per-folder width cap.
 *
 * Why: nothing in the pipeline ever resized or re-encoded uploads — the raw
 * `req.file.buffer` went straight into the bucket. That left prod serving
 * ~1.3 MB PNGs for 52x52 category tiles and ~485 KB PNGs for grid thumbnails.
 * Capping width and re-encoding to WebP cuts the bytes by roughly an order of
 * magnitude with no visible quality loss at the sizes we actually render.
 *
 * Deliberately dependency-free apart from sharp (no config/env, no logger) so
 * the backfill script can share the exact same policy without pulling in the
 * dotenv cascade that would re-point it at the wrong environment.
 */

const sharp = require('sharp');

// Width caps are set from how large each image is ever rendered, times a ~3x
// device-pixel-ratio headroom, rounded up. Raising a cap is safe; lowering one
// only affects future uploads (existing objects keep their own URLs).
//   products   — grid tile ~170dp, detail view full-width
//   banners    — full-width, 230dp tall
//   categories — 52x52dp chip on the home grid
//   deliveries — proof-of-delivery photos, only ever viewed full-screen once
const IMAGE_POLICY = {
  products:   { maxWidth: 1200, quality: 82 },
  banners:    { maxWidth: 1600, quality: 80 },
  categories: { maxWidth: 320,  quality: 82 },
  deliveries: { maxWidth: 1280, quality: 75 },
};

const DEFAULT_POLICY = { maxWidth: 1600, quality: 82 };

// Formats Flutter cannot decode. Its image codecs cover JPEG, PNG, GIF, WebP
// (both animated), BMP and WBMP — AVIF/HEIC/TIFF render as the error widget, no
// matter how small the file is. These must always be converted, so the usual
// "keep whichever is smaller" rule is skipped for them: a 7 KB AVIF that the app
// cannot draw is worth less than a 20 KB WebP it can. sharp reports AVIF as
// format 'heif', so match on the decoded format as well as the declared type —
// stored content-types are not always accurate.
const CLIENT_UNSUPPORTED_TYPES = new Set(['image/avif', 'image/heic', 'image/heif', 'image/tiff']);
const CLIENT_UNSUPPORTED_FORMATS = new Set(['heif', 'avif', 'tiff']);

// Formats we can safely decode and re-encode. Anything else (PDF, SVG, unknown)
// passes through untouched.
const OPTIMIZABLE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
]);

function policyFor(folder) {
  return IMAGE_POLICY[folder] || DEFAULT_POLICY;
}

function extensionFor(mimeType) {
  return (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
}

/**
 * @returns {Promise<{buffer: Buffer, mimeType: string, optimized: boolean,
 *   reason: string, bytesBefore: number, bytesAfter: number,
 *   width: number|null, height: number|null}>}
 *
 * Never throws. On any failure it returns the original buffer with
 * `optimized: false` and a reason — a corrupt or exotic image should degrade to
 * today's behaviour (upload as-is), not fail the caller's request.
 */
async function optimizeImage(buffer, mimeType, folder) {
  const unchanged = (reason) => ({
    buffer,
    mimeType,
    optimized: false,
    reason,
    bytesBefore: buffer.length,
    bytesAfter: buffer.length,
    width: null,
    height: null,
  });

  if (!OPTIMIZABLE_TYPES.has(mimeType)) return unchanged('unsupported-type');

  const { maxWidth, quality } = policyFor(folder);

  try {
    // failOn: 'none' — tolerate slightly truncated files rather than rejecting
    // an upload a browser would have rendered fine.
    const image = sharp(buffer, { failOn: 'none' });
    const meta = await image.metadata();

    // When the client cannot draw this format at all, conversion is mandatory
    // and the "is it smaller?" and "is it animated?" escape hatches below do not
    // apply — an unrenderable image has no value to preserve.
    const mustConvert = CLIENT_UNSUPPORTED_TYPES.has(mimeType)
      || CLIENT_UNSUPPORTED_FORMATS.has(meta.format);

    // Animated WebP/GIF would be flattened to a single frame by the pipeline
    // below, silently destroying the animation. Leave them alone.
    if (!mustConvert && meta.pages && meta.pages > 1) return unchanged('animated');

    // WebP already within the cap is this function's own output shape, so leave
    // it alone. Without this, re-encoding lossy WebP at the same quality yields
    // a slightly smaller file every time — it would pass the size check below,
    // making the backfill script non-idempotent and degrading images a little
    // more on each run. The trade-off is that an oversized-but-narrow WebP
    // (e.g. a lossless export) is left as-is; that has not occurred in practice.
    if (meta.format === 'webp' && meta.width && meta.width <= maxWidth) {
      return unchanged('already-optimized');
    }

    const output = await image
      // Auto-orients from the EXIF orientation tag, then strips it. Must come
      // before resize, or a portrait phone photo resizes against its unrotated
      // dimensions and lands sideways.
      .rotate()
      // withoutEnlargement: never upscale a small source just to hit the cap.
      .resize({ width: maxWidth, withoutEnlargement: true })
      // WebP rather than JPEG because product cutouts have real alpha channels
      // (see scripts/remove-bg.py) that JPEG would flatten onto black.
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    // An already-small, already-optimised source can come out bigger. Keep
    // whichever is smaller so the script is safe to re-run over its own output —
    // unless the client cannot render the source format at all.
    if (!mustConvert && output.data.length >= buffer.length) return unchanged('no-gain');

    return {
      buffer: output.data,
      mimeType: 'image/webp',
      optimized: true,
      reason: mustConvert ? 'ok (converted from unrenderable format)' : 'ok',
      bytesBefore: buffer.length,
      bytesAfter: output.data.length,
      width: output.info.width,
      height: output.info.height,
    };
  } catch (err) {
    return unchanged(`error: ${err.message}`);
  }
}

module.exports = {
  optimizeImage, extensionFor, policyFor,
  IMAGE_POLICY, OPTIMIZABLE_TYPES, CLIENT_UNSUPPORTED_TYPES,
};
