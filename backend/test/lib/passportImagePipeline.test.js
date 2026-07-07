// @ts-check
/**
 * backend/lib/passportImagePipeline.js — sharp-based passport preprocessing.
 *
 * These tests only exercise the public contract and failure modes. They do NOT
 * require real passport scans; a synthetic image is enough to verify that the
 * pipeline produces a buffer of the expected shape and degrades gracefully.
 */
import { describe, test, expect } from 'vitest';
import sharp from 'sharp';
import {
  preprocessImage,
  preprocessForViz,
  detectSkewAngle,
} from '../../lib/passportImagePipeline.js';

async function makeTestImage({ width = 800, height = 600, rotate = 0 } = {}) {
  // White background with two black horizontal stripes near the bottom to mimic
  // an MRZ band.
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <rect x="0" y="${Math.floor(height * 0.82)}" width="100%" height="12" fill="black"/>
      <rect x="0" y="${Math.floor(height * 0.9)}" width="100%" height="12" fill="black"/>
    </svg>
  `;
  return sharp(Buffer.from(svg))
    .rotate(rotate, { background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
}

describe('preprocessImage', () => {
  test('returns a larger PNG buffer for a synthetic passport image', async () => {
    const input = await makeTestImage();
    const out = await preprocessImage(input, { mrzBand: true });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeGreaterThan(100);
    expect(meta.height).toBeGreaterThan(50);
  });

  test('mrzBand crop produces a shorter image than full-page processing', async () => {
    const input = await makeTestImage();
    const band = await preprocessImage(input, { mrzBand: true });
    const full = await preprocessImage(input, { mrzBand: false });
    const bandMeta = await sharp(band).metadata();
    const fullMeta = await sharp(full).metadata();
    expect(bandMeta.height).toBeLessThan(fullMeta.height);
  });

  test('returns null for empty / invalid input', async () => {
    expect(await preprocessImage(Buffer.alloc(0))).toBeNull();
    expect(await preprocessImage(null)).toBeNull();
    expect(await preprocessImage(Buffer.from('not an image'))).toBeNull();
  });
});

describe('preprocessForViz', () => {
  test('returns a greyscale PNG of the deskewed page', async () => {
    const input = await makeTestImage();
    const out = await preprocessForViz(input);
    expect(Buffer.isBuffer(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeGreaterThanOrEqual(1200);
  });

  test('returns null for invalid input', async () => {
    expect(await preprocessForViz(Buffer.from('not an image'))).toBeNull();
  });
});

describe('detectSkewAngle', () => {
  test('detects a small clockwise rotation', async () => {
    const input = await makeTestImage({ rotate: 3 });
    const angle = await detectSkewAngle(input);
    // Allow a small margin; the coarse+fine sweep should land near -3°.
    expect(angle).toBeLessThan(-1);
    expect(angle).toBeGreaterThan(-6);
  });

  test('returns near zero for an already-straight image', async () => {
    const input = await makeTestImage({ rotate: 0 });
    const angle = await detectSkewAngle(input);
    expect(Math.abs(angle)).toBeLessThan(2);
  });
});
