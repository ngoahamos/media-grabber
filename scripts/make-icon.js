#!/usr/bin/env node
'use strict';

/**
 * Generates build/icon-v2.png — the app icon electron-builder turns into .icns,
 * .ico and the Linux PNG set.
 *
 * Written as a tiny software rasteriser + PNG encoder so the repo needs no
 * image tooling or binary asset checked in. The original build/icon.png is
 * intentionally retained as a fallback while this version is in use.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
const SS = 3;                       // supersampling factor (3×3 per pixel)

/* ---- geometry helpers (unit coordinates, 0..1) --------------------------- */

/** Rounded-rectangle coverage test. */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Barycentric point-in-triangle test. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

const lerp = (a, b, t) => a + (b - a) * t;

/* ---- the icon itself ----------------------------------------------------- */

/** Deep navy plate with a restrained blue highlight toward the top-left. */
function backgroundColor(x, y) {
  const highlight = Math.max(0, 1 - Math.hypot(x - 0.26, y - 0.18) / 0.9);
  return [
    Math.round(lerp(0x08, 0x12, highlight)),
    Math.round(lerp(0x0c, 0x1b, highlight)),
    Math.round(lerp(0x18, 0x38, highlight)),
  ];
}

/** Brand gradient, matching the app's --accent → --accent-hot ramp. */
function glyphColor(x, y) {
  const t = Math.min(Math.max((x + y - 0.42) / 1.16, 0), 1);
  return [
    Math.round(lerp(0x6c, 0x8b, t)),
    Math.round(lerp(0x8c, 0x5c, t)),
    Math.round(lerp(0xff, 0xf6, t)),
  ];
}

/** True where the combined download + media glyph should be drawn. */
function isGlyph(x, y) {
  const stem = inRoundedRect(x, y, 0.37, 0.215, 0.63, 0.565, 0.045);
  const head = inTriangle(x, y, 0.255, 0.515, 0.745, 0.515, 0.5, 0.745);
  const tray = inRoundedRect(x, y, 0.275, 0.79, 0.725, 0.855, 0.032);
  const trayLeft = inRoundedRect(x, y, 0.275, 0.745, 0.34, 0.84, 0.032);
  const trayRight = inRoundedRect(x, y, 0.66, 0.745, 0.725, 0.84, 0.032);

  // A play button cut from the arrow makes the mark specific to media rather
  // than another generic file-transfer utility.
  const playCutout = inTriangle(x, y, 0.442, 0.39, 0.442, 0.57, 0.575, 0.48);
  return (stem || head || tray || trayLeft || trayRight) && !playCutout;
}

/** True where the rounded app-icon plate is opaque. */
function isPlate(x, y) {
  return inRoundedRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2);
}

/** Render RGBA pixels with 3×3 supersampled edges. */
function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const samples = SS * SS;

  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / SIZE;
          const y = (py + (sy + 0.5) / SS) / SIZE;

          if (!isPlate(x, y)) continue;          // transparent outside the plate
          a += 255;

          if (isGlyph(x, y)) {
            const [gr, gg, gb] = glyphColor(x, y);
            r += gr; g += gg; b += gb;
          } else {
            const [br, bg, bb] = backgroundColor(x, y);
            r += br; g += bg; b += bb;
          }
        }
      }

      const i = (py * SIZE + px) * 4;
      // Average the samples; colour is pre-averaged over covered samples only
      // would over-darken edges, so divide colour by the sample count too.
      pixels[i] = Math.round(r / samples);
      pixels[i + 1] = Math.round(g / samples);
      pixels[i + 2] = Math.round(b / samples);
      pixels[i + 3] = Math.round(a / samples);
    }
  }
  return pixels;
}

/* ---- minimal PNG encoder ------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  // 10-12 stay zero: deflate / adaptive filtering / no interlace

  // Prefix every scanline with filter byte 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- run ----------------------------------------------------------------- */

const out = path.join(__dirname, '..', 'build', 'icon-v2.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(render(), SIZE));
console.log(`Wrote ${path.relative(process.cwd(), out)} (${SIZE}×${SIZE})`);
