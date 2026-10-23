// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

// Cursor sprite analysis: figures out the colors and the visual center of
// the current cursor so the hide animation can match it.
//
// analyzeSprite() is pure so it can be tested outside of GNOME Shell.

import Gio from 'gi://Gio'
import Shell from 'gi://Shell'

Gio._promisify(Shell.Screenshot, 'composite_to_stream')

const OPAQUE = 200

function dominantColor(pixels, indices) {
  // Histogram over a coarse 4-bit-per-channel grid, then average the
  // members of the most populated bin. Picks the "main" color instead of
  // a muddy mix of fill, gradient and anti-aliasing.
  const bins = new Map()
  for (const o of indices) {
    const key = ((pixels[o] >> 4) << 8) | ((pixels[o + 1] >> 4) << 4) | (pixels[o + 2] >> 4)
    let bin = bins.get(key)
    if (!bin) {
      bin = {n: 0, r: 0, g: 0, b: 0}
      bins.set(key, bin)
    }
    bin.n++
    bin.r += pixels[o]
    bin.g += pixels[o + 1]
    bin.b += pixels[o + 2]
  }

  let best = null
  for (const bin of bins.values()) {
    if (!best || bin.n > best.n)
      best = bin
  }
  if (!best)
    return null

  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  }
}

function colorDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

/**
 * @param {Uint8Array} pixels - non-premultiplied RGB(A) data
 * @param {number} width
 * @param {number} height
 * @param {number} rowstride
 * @param {number} channels - 3 or 4
 * @returns {{fill, outline, cx, cy, bw, bh}} colors as {r,g,b} (0-255),
 *   outline is null when the cursor has none; center (cx, cy) and size
 *   (bw, bh) of the opaque area, in sprite pixels.
 */
export function analyzeSprite(pixels, width, height, rowstride, channels) {
  const alpha = new Uint8Array(width * height)
  let sumA = 0, sumX = 0, sumY = 0
  let minX = width, minY = height, maxX = -1, maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = channels === 4 ? pixels[y * rowstride + x * 4 + 3] : 255
      alpha[y * width + x] = a
      sumA += a
      sumX += a * x
      sumY += a * y
      if (a >= OPAQUE) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
  }

  if (maxX < 0)
    return null

  // Chessboard distance from each opaque pixel to the nearest transparent
  // one (two-pass chamfer). Depth 1 is the outermost ring, i.e. the
  // contrast outline; the deepest pixels are the fill, even on thin
  // shapes like the I-beam.
  const depth = new Uint16Array(width * height)
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height) ? 0 : depth[y * width + x]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      depth[i] = alpha[i] < OPAQUE ? 0
        : 1 + Math.min(at(x - 1, y), at(x - 1, y - 1), at(x, y - 1), at(x + 1, y - 1))
    }
  }
  let maxDepth = 0
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (!depth[i])
        continue
      depth[i] = Math.min(depth[i],
        1 + Math.min(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1)))
      maxDepth = Math.max(maxDepth, depth[i])
    }
  }

  // Fill = the deepest layers, taken until they cover ~10% of the shape
  // (so a stray highlight dot in the middle doesn't win on its own).
  const layers = Array.from({length: maxDepth + 1}, () => [])
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = depth[y * width + x]
      if (d)
        layers[d].push(y * rowstride + x * channels)
    }
  }
  const opaqueCount = layers.reduce((n, l) => n + l.length, 0)
  const ring = layers[1]
  let interior = []
  for (let d = maxDepth; d >= 2 && interior.length < opaqueCount * 0.1; d--)
    interior = interior.concat(layers[d])

  const fill = dominantColor(pixels, interior.length ? interior : ring)
  let outline = interior.length ? dominantColor(pixels, ring) : null
  if (outline && colorDistance(fill, outline) < 48)
    outline = null

  return {
    fill,
    outline,
    cx: sumX / sumA + 0.5,
    cy: sumY / sumA + 0.5,
    bw: maxX - minX + 1,
    bh: maxY - minY + 1,
  }
}

/**
 * Reads back the pixels of a Cogl texture (the cursor sprite) and analyzes
 * them. Cogl.Texture.get_data() can't fill a buffer from GJS, so the
 * texture goes through the screenshot compositor, which hands us a pixbuf.
 */
export async function readSprite(sprite) {
  const stream = Gio.MemoryOutputStream.new_resizable()
  const pixbuf = await Shell.Screenshot.composite_to_stream(
    sprite, 0, 0, -1, -1, 1, null, 0, 0, 1, stream)
  stream.close(null)

  return analyzeSprite(
    pixbuf.get_pixels(),
    pixbuf.get_width(),
    pixbuf.get_height(),
    pixbuf.get_rowstride(),
    pixbuf.get_n_channels())
}
