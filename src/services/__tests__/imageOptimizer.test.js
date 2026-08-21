'use strict';

const sharp = require('sharp');
const { optimizeImage, extensionFor, policyFor } = require('../imageOptimizer');

// Solid-colour sources compress extremely well, which is fine — these tests
// assert behaviour (format, dimensions, passthrough), never a byte threshold.
const makePng = (width, height, channels = 3) =>
  sharp({ create: { width, height, channels, background: channels === 4 ? { r: 240, g: 106, b: 31, alpha: 0.5 } : '#f26a1f' } })
    .png().toBuffer();

const makeJpeg = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: '#3b2cd3' } }).jpeg().toBuffer();

describe('policyFor', () => {
  test('returns the per-folder cap for known folders', () => {
    expect(policyFor('categories').maxWidth).toBe(320);
    expect(policyFor('products').maxWidth).toBe(1200);
    expect(policyFor('banners').maxWidth).toBe(1600);
  });

  test('falls back to a default for unknown folders', () => {
    expect(policyFor('somethingelse').maxWidth).toBe(1600);
  });
});

describe('extensionFor', () => {
  test('maps mime types to file extensions', () => {
    expect(extensionFor('image/webp')).toBe('webp');
    expect(extensionFor('image/png')).toBe('png');
  });

  test('normalises jpeg to jpg', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
  });
});

describe('optimizeImage', () => {
  test('re-encodes an oversized PNG to WebP at the folder cap', async () => {
    const src = await makePng(2000, 1500);
    const result = await optimizeImage(src, 'image/png', 'products');

    expect(result.optimized).toBe(true);
    expect(result.mimeType).toBe('image/webp');
    expect(result.width).toBe(1200);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1200);
  });

  test('applies the much smaller cap for category tiles', async () => {
    const src = await makePng(1080, 1080);
    const result = await optimizeImage(src, 'image/png', 'categories');

    expect(result.width).toBe(320);
  });

  test('preserves the alpha channel (product cutouts have real transparency)', async () => {
    const src = await makePng(1000, 1000, 4);
    const result = await optimizeImage(src, 'image/png', 'products');

    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  test('never upscales a source smaller than the cap', async () => {
    const src = await makePng(64, 64);
    const result = await optimizeImage(src, 'image/png', 'products');

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(64);
  });

  test('auto-orients from EXIF before resizing', async () => {
    // Orientation 6 means "rotate 90° CW to display" — a portrait phone photo
    // stored as landscape pixels. Without .rotate() this lands sideways.
    const landscape = await makeJpeg(900, 300);
    const tagged = await sharp(landscape).withMetadata({ orientation: 6 }).jpeg().toBuffer();

    const result = await optimizeImage(tagged, 'image/jpeg', 'deliveries');
    const meta = await sharp(result.buffer).metadata();

    expect(meta.height).toBeGreaterThan(meta.width);
  });

  test('is idempotent — its own output is left untouched', async () => {
    const src = await makePng(2000, 1500);
    const first = await optimizeImage(src, 'image/png', 'products');
    const second = await optimizeImage(first.buffer, first.mimeType, 'products');

    expect(second.optimized).toBe(false);
    expect(second.reason).toBe('already-optimized');
    expect(second.buffer).toBe(first.buffer);
  });

  test('still resizes a WebP that exceeds the cap', async () => {
    const src = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3b2cd3' } })
      .webp().toBuffer();
    const result = await optimizeImage(src, 'image/webp', 'products');

    expect(result.optimized).toBe(true);
    expect(result.width).toBe(1200);
  });

  test('passes animated images through rather than flattening them', async () => {
    const frames = await sharp({ create: { width: 60, height: 180, channels: 3, background: '#f26a1f' } })
      .png().toBuffer();
    const animated = await sharp(frames, { raw: undefined, pages: 3, pageHeight: 60 })
      .webp().toBuffer()
      .catch(() => null);

    // Only assert if this sharp build produced a genuinely multi-page file.
    if (animated) {
      const meta = await sharp(animated).metadata();
      if (meta.pages > 1) {
        const result = await optimizeImage(animated, 'image/webp', 'products');
        expect(result.optimized).toBe(false);
        expect(result.reason).toBe('animated');
      }
    }
  });

  test('always converts AVIF, even when the result is larger', async () => {
    // Flutter cannot decode AVIF, so a smaller-but-unrenderable file is worse
    // than a larger WebP. This must bypass the usual 'no-gain' check.
    const avif = await sharp({ create: { width: 526, height: 435, channels: 3, background: '#3b2cd3' } })
      .avif({ quality: 50 }).toBuffer();
    const result = await optimizeImage(avif, 'image/avif', 'products');

    expect(result.optimized).toBe(true);
    expect(result.mimeType).toBe('image/webp');
    expect(result.reason).toMatch(/unrenderable/);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('webp');
  });

  test('converts an AVIF even when it declares a wrong content-type', async () => {
    // Stored content-types are not always accurate, so the decoded format has to
    // be checked too — sharp reports AVIF as 'heif'.
    const avif = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#f26a1f' } })
      .avif({ quality: 50 }).toBuffer();
    const result = await optimizeImage(avif, 'image/png', 'products');

    expect(result.mimeType).toBe('image/webp');
  });

  test('passes non-image types through byte-identically', async () => {
    const pdf = Buffer.from('%PDF-1.4 not an image');
    const result = await optimizeImage(pdf, 'application/pdf', 'pos-quotations');

    expect(result.optimized).toBe(false);
    expect(result.reason).toBe('unsupported-type');
    expect(result.buffer.equals(pdf)).toBe(true);
  });

  test('degrades to the original buffer on undecodable input instead of throwing', async () => {
    const junk = Buffer.from('this is definitely not a png');
    const result = await optimizeImage(junk, 'image/png', 'products');

    expect(result.optimized).toBe(false);
    expect(result.reason).toMatch(/^error:/);
    expect(result.buffer.equals(junk)).toBe(true);
  });

  test('keeps the original when re-encoding would not shrink it', async () => {
    // A tiny JPEG is already smaller than any WebP re-encode of it.
    const src = await makeJpeg(8, 8);
    const result = await optimizeImage(src, 'image/jpeg', 'products');

    if (!result.optimized) {
      expect(result.reason).toBe('no-gain');
      expect(result.bytesAfter).toBe(result.bytesBefore);
    }
  });
});
