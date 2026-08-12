// Regenerate assets/brand/star-icon.svg — the browser-tab favicon.
//
// It's just the white STAR rocket logo on a transparent background (no badge).
// This means it's crisp on dark tabs and nearly invisible on light tabs — that's
// a deliberate, accepted tradeoff for now.
//
// The source PNG has a wide transparent margin around the rocket, which makes the
// icon look tiny in a tab. We decode its alpha channel to find the logo's true
// bounding box and crop the SVG to it, so the rocket fills the icon.
//
// Source of truth is the committed master assets/brand/star-logo-white.png.
// After running this, run scripts/sync-brand.sh to fan the SVG out to each app's
// public/, then commit assets/brand/ and the copies.
//
//   node scripts/make-star-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets/brand/star-logo-white.png');
const OUT = join(ROOT, 'assets/brand/star-icon.svg');

const buf = readFileSync(SRC);

// --- Minimal PNG decode (8-bit RGBA, non-interlaced) to get the alpha bbox ---
function decodePng(b) {
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const bitDepth = b[24], colorType = b[25], interlace = b[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); need 8-bit RGBA non-interlaced`);
  }
  const idat = [];
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  const paeth = (a, bb, c) => {
    const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const rin = y * (stride + 1) + 1, rout = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rin + x];
      const a = x >= bpp ? px[rout + x - bpp] : 0;
      const bb = y > 0 ? px[rout - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[rout - stride + x - bpp] : 0;
      let out;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + bb; break;
        case 3: out = v + ((a + bb) >> 1); break;
        case 4: out = v + paeth(a, bb, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      px[rout + x] = out & 0xff;
    }
  }
  return { w, h, px };
}

const { w, h, px } = decodePng(buf);

// Tight bounding box of visible (alpha > threshold) pixels.
const ALPHA = 16;
let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > ALPHA) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error('logo appears fully transparent');
const bw = maxX - minX + 1, bh = maxY - minY + 1;

// viewBox = the logo's content bbox, so the SVG is cropped tight to the rocket
// (transparent everywhere else). No background.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${bw} ${bh}" width="${bw}" height="${bh}">
  <image width="${w}" height="${h}" href="data:image/png;base64,${buf.toString('base64')}"/>
</svg>
`;

writeFileSync(OUT, svg);
console.log(`logo ${w}x${h}, cropped to ${bw}x${bh} @ (${minX},${minY}) -> ${OUT} (${svg.length} bytes)`);
