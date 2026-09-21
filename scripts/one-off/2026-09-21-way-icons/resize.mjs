// ─── WAY's PWA icons: make the files the size the manifest advertises ────
//
// WHY THIS EXISTS
// /way/manifest.json declares `512x512` for both icons, but the files were
// 1254x1254 — 1.0 MB and 939 KB. Two consequences, both real:
//
//   * an install downloaded ~2 MB of icon (they are in /way/sw.js's PRECACHE,
//     so every install pays it), on the phones this app is actually used on;
//   * the declared size was a lie, which is the exact failure mode smoke §16
//     exists to catch for the ROOT manifest — the same rule simply was never
//     applied to the /way/ scope.
//
// It keeps the artwork and changes only the raster size, so the mark is
// byte-for-byte the same drawing at the size it is used at. A 512 icon is
// displayed at <=192 px on every Android launcher, so nothing is lost.
//
// Run it from a project that has `sharp` on disk (Home deliberately has no
// dependencies at all — its frontend is static, served verbatim):
//
//   cd ../W.A.Y && node ../Home/scripts/one-off/2026-09-21-way-icons/resize.mjs
//
// It is idempotent: running it on already-correct files rewrites them
// identically. Verify afterwards with `npm run smoke` (section 16).

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Anchored to the CURRENT directory, not to this file: Home has no dependencies
// on purpose, so the only sharp on disk is a sibling project's — which is what
// the invocation above cd's into. `require` would otherwise search up from
// Home/scripts/one-off/ and find nothing.
const require = createRequire(join(process.cwd(), 'package.json'))
const sharp = require('sharp')

const here = dirname(fileURLToPath(import.meta.url))
const wayDir = join(here, '..', '..', '..', 'public', 'way')

const TARGETS = [
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512 },
  { file: 'icon-64.png', size: 64 },
]

for (const t of TARGETS) {
  const path = join(wayDir, t.file)
  const before = statSync(path).size
  const src = readFileSync(path)
  const meta = await sharp(src).metadata()
  // `flatten` on a transparent source would blacken it; these are opaque RGB.
  const out = await sharp(src)
    .resize(t.size, t.size, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer()
  writeFileSync(path, out)
  console.log(
    `${t.file}: ${meta.width}x${meta.height} ${(before / 1024).toFixed(0)} KB` +
    ` -> ${t.size}x${t.size} ${(out.length / 1024).toFixed(0)} KB`
  )
}
