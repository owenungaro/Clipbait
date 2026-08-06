/**
 * Draws Clipbait's mark and writes it out as PNG and ICO.
 *
 * The mark is the app's own subject: a ring standing for the rolling buffer,
 * broken where the write head sits, around a solid tally block.
 *
 * Authored on a 16x16 grid and scaled by whole multiples, so it stays crisp at
 * every size Windows asks for. No image libraries — a few shapes and a PNG
 * encoder are enough.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CLEAR = [0, 0, 0, 0]
const PLATE = [0x1b, 0x1d, 0x26, 255]
const EDGE = [0x2f, 0x32, 0x42, 255]
const ACCENT = [0x7d, 0x8c, 0xf8, 255]
const LIVE = [0xf2, 0x64, 0x7c, 255]

const GRID = 16

/**
 * Author the mark once, at 16x16, as a grid of colours.
 * @param {boolean} plate  draw the bone tile and ink border (app icon) or not (tray)
 */
function authorGrid(plate) {
  const cells = new Array(GRID * GRID).fill(CLEAR)
  const c = GRID / 2

  const ringOuter = 6.6
  const ringInner = 4.4
  const dotRadius = 2.3
  // The break in the ring sits up and to the right, reading as a write head.
  const gapCenter = -Math.PI / 4
  const gapHalf = 0.5

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const dist = Math.hypot(dx, dy)
      let colour = CLEAR

      if (plate) {
        const edge = x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1
        colour = edge ? EDGE : PLATE
      }

      if (dist >= ringInner && dist <= ringOuter) {
        let angle = Math.atan2(dy, dx) - gapCenter
        while (angle > Math.PI) angle -= 2 * Math.PI
        while (angle < -Math.PI) angle += 2 * Math.PI
        if (Math.abs(angle) > gapHalf) colour = ACCENT
      }

      if (dist <= dotRadius) colour = LIVE

      cells[y * GRID + x] = colour
    }
  }
  return cells
}

/** Nearest-neighbour upscale by a whole factor — the only honest way to grow pixel art. */
function rasterise(cells, size) {
  const scale = size / GRID
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = cells[Math.floor(y / scale) * GRID + Math.floor(x / scale)]
      const i = (y * size + x) * 4
      out[i] = src[0]
      out[i + 1] = src[1]
      out[i + 2] = src[2]
      out[i + 3] = src[3]
    }
  }
  return out
}

/* ------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(rgba, size) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------- ico */

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach((entry, i) => {
    const base = i * 16
    dir[base] = entry.size >= 256 ? 0 : entry.size
    dir[base + 1] = entry.size >= 256 ? 0 : entry.size
    dir.writeUInt16LE(1, base + 4) // colour planes
    dir.writeUInt16LE(32, base + 6) // bits per pixel
    dir.writeUInt32LE(entry.png.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/* ------------------------------------------------------------------ main */

const resources = path.join(root, 'resources')
const build = path.join(root, 'build')
mkdirSync(resources, { recursive: true })
mkdirSync(build, { recursive: true })

const plated = authorGrid(true)
const bare = authorGrid(false)

writeFileSync(path.join(resources, 'icon.png'), encodePng(rasterise(plated, 256), 256))
writeFileSync(path.join(resources, 'tray.png'), encodePng(rasterise(bare, 16), 16))
writeFileSync(path.join(resources, 'tray@2x.png'), encodePng(rasterise(bare, 32), 32))

// Every size is a whole multiple of the 16px grid, so nothing is resampled.
const icoSizes = [16, 32, 48, 64, 128, 256]
writeFileSync(
  path.join(build, 'icon.ico'),
  encodeIco(icoSizes.map((size) => ({ size, png: encodePng(rasterise(plated, size), size) })))
)

console.log('Wrote resources/icon.png, resources/tray.png, resources/tray@2x.png, build/icon.ico')
