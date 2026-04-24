#!/usr/bin/env node
'use strict';

/**
 * Generates icon.ico with sizes 16x16, 32x32, 48x48, 256x256.
 * Design: deep-purple rounded square, white circle badge, dark arched door with handle.
 * Pure Node.js — no external dependencies.
 */

const fs   = require('fs');
const path = require('path');

// ── Pixel renderer ─────────────────────────────────────────────────────────────

function blend(pixels, size, x, y, r, g, b, a) {
  if (x < 0 || x >= size || y < 0 || y >= size || a <= 0) return;
  const i  = (y * size + x) * 4;
  const fa = a / 255, ea = pixels[i + 3] / 255;
  const oa = fa + ea * (1 - fa);
  if (oa < 0.001) return;
  pixels[i]     = Math.round((r * fa + pixels[i]     * ea * (1 - fa)) / oa);
  pixels[i + 1] = Math.round((g * fa + pixels[i + 1] * ea * (1 - fa)) / oa);
  pixels[i + 2] = Math.round((b * fa + pixels[i + 2] * ea * (1 - fa)) / oa);
  pixels[i + 3] = Math.round(oa * 255);
}

// Anti-aliased filled rounded rectangle
function fillRRect(pixels, size, x0, y0, x1, y1, r, R, G, B) {
  const lx = Math.max(0, Math.floor(x0 - 1));
  const rx = Math.min(size - 1, Math.ceil(x1 + 1));
  const ly = Math.max(0, Math.floor(y0 - 1));
  const ry = Math.min(size - 1, Math.ceil(y1 + 1));
  for (let py = ly; py <= ry; py++) {
    for (let px = lx; px <= rx; px++) {
      const dx   = Math.max(0, Math.max(x0 + r - px, px - (x1 - r)));
      const dy   = Math.max(0, Math.max(y0 + r - py, py - (y1 - r)));
      const dist = Math.sqrt(dx * dx + dy * dy);
      const a    = Math.round(Math.min(1, Math.max(0, r + 0.5 - dist)) * 255);
      if (a > 0) blend(pixels, size, px, py, R, G, B, a);
    }
  }
}

// Anti-aliased filled circle
function fillCircle(pixels, size, cx, cy, r, R, G, B) {
  const lx = Math.max(0, Math.floor(cx - r - 1));
  const rx = Math.min(size - 1, Math.ceil(cx + r + 1));
  const ly = Math.max(0, Math.floor(cy - r - 1));
  const ry = Math.min(size - 1, Math.ceil(cy + r + 1));
  for (let py = ly; py <= ry; py++) {
    for (let px = lx; px <= rx; px++) {
      const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      const a    = Math.round(Math.min(1, Math.max(0, r + 0.5 - dist)) * 255);
      if (a > 0) blend(pixels, size, px, py, R, G, B, a);
    }
  }
}

// Anti-aliased filled upper semicircle (y <= cy half)
function fillSemiTop(pixels, size, cx, cy, r, R, G, B) {
  const lx = Math.max(0, Math.floor(cx - r - 1));
  const rx = Math.min(size - 1, Math.ceil(cx + r + 1));
  const ly = Math.max(0, Math.floor(cy - r - 1));
  const ry = Math.min(size - 1, Math.ceil(cy + 1));
  for (let py = ly; py <= ry; py++) {
    for (let px = lx; px <= rx; px++) {
      const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      const a    = Math.round(Math.min(1, Math.max(0, r + 0.5 - dist)) * 255);
      if (a > 0) blend(pixels, size, px, py, R, G, B, a);
    }
  }
}

// ── Icon design ───────────────────────────────────────────────────────────────

function drawIcon(size) {
  const s       = size;
  const pixels  = new Uint8Array(s * s * 4); // RGBA, init transparent
  const cx      = s * 0.5;

  // 1. Background: deep-purple rounded square  #5b21b6 → (91, 33, 182)
  fillRRect(pixels, s, 0, 0, s - 1, s - 1, s * 0.22, 91, 33, 182);

  // 2. White circle badge
  const badgeCy = s * 0.46;
  const badgeR  = s * 0.34;
  fillCircle(pixels, s, cx, badgeCy, badgeR, 255, 255, 255);

  // 3. Arched door  #1e1e2e → (30, 30, 46)
  const dW      = s * 0.25;
  const dBodyH  = s * 0.30;
  const archCy  = badgeCy - dBodyH * 0.26;
  const archR   = dW / 2;
  const dBot    = archCy + dBodyH;

  fillSemiTop(pixels, s, cx, archCy, archR, 30, 30, 46);
  fillRRect(pixels, s, cx - dW / 2, archCy, cx + dW / 2, dBot, 1, 30, 30, 46);

  // 4. Door handle  #cba6f7 → (203, 166, 247)
  const hx = cx + dW * 0.21;
  const hy = archCy + dBodyH * 0.56;
  fillCircle(pixels, s, hx, hy, s * 0.023, 203, 166, 247);

  return pixels;
}

// ── ICO builder ───────────────────────────────────────────────────────────────

function buildBMPData(size, pixels) {
  const andRowBytes   = Math.ceil(size / 32) * 4;
  const pixelDataSize = size * size * 4;
  const andMaskSize   = andRowBytes * size;
  const buf           = Buffer.alloc(40 + pixelDataSize + andMaskSize, 0);
  let off = 0;

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, off);        off += 4;
  buf.writeInt32LE(size, off);       off += 4;
  buf.writeInt32LE(size * 2, off);   off += 4; // doubled for AND mask
  buf.writeUInt16LE(1, off);         off += 2;
  buf.writeUInt16LE(32, off);        off += 2;
  buf.writeUInt32LE(0, off);         off += 4; // BI_RGB
  buf.writeUInt32LE(pixelDataSize, off); off += 4;
  buf.writeInt32LE(0, off);          off += 4;
  buf.writeInt32LE(0, off);          off += 4;
  buf.writeUInt32LE(0, off);         off += 4;
  buf.writeUInt32LE(0, off);         off += 4;

  // Pixel data, bottom-to-top, BGRA
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      buf[off++] = pixels[src + 2];
      buf[off++] = pixels[src + 1];
      buf[off++] = pixels[src + 0];
      buf[off++] = pixels[src + 3];
    }
  }

  // AND mask: bit = 1 where alpha == 0 (transparent)
  const andBase = 40 + pixelDataSize;
  for (let y = size - 1; y >= 0; y--) {
    const maskRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      if (pixels[src + 3] === 0) {
        const bi = andBase + maskRow * andRowBytes + Math.floor(x / 8);
        buf[bi] |= (0x80 >> (x % 8));
      }
    }
  }

  return buf;
}

function buildICO(sizes) {
  const bmpDatas = sizes.map(sz => buildBMPData(sz, drawIcon(sz)));
  const count    = sizes.length;
  const dirBytes = 6 + count * 16;
  const total    = dirBytes + bmpDatas.reduce((s, b) => s + b.length, 0);
  const buf      = Buffer.alloc(total);
  let off = 0;

  buf.writeUInt16LE(0, off); off += 2; // reserved
  buf.writeUInt16LE(1, off); off += 2; // type = icon
  buf.writeUInt16LE(count, off); off += 2;

  let dataOffset = dirBytes;
  for (let i = 0; i < count; i++) {
    const sz = sizes[i];
    buf.writeUInt8(sz >= 256 ? 0 : sz, off++); // width  (0 means 256)
    buf.writeUInt8(sz >= 256 ? 0 : sz, off++); // height
    buf.writeUInt8(0, off++);                   // colorCount
    buf.writeUInt8(0, off++);                   // reserved
    buf.writeUInt16LE(1, off); off += 2;        // planes
    buf.writeUInt16LE(32, off); off += 2;       // bitCount
    buf.writeUInt32LE(bmpDatas[i].length, off); off += 4;
    buf.writeUInt32LE(dataOffset, off); off += 4;
    dataOffset += bmpDatas[i].length;
  }

  for (const d of bmpDatas) { d.copy(buf, off); off += d.length; }
  return buf;
}

// ── Run ───────────────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, 'icon.ico');
fs.writeFileSync(outPath, buildICO([16, 32, 48, 256]));
console.log(`icon.ico written to ${outPath}`);
