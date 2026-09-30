#!/usr/bin/env node
// ─── one-off: give every § citation its document name ────────────
// The rule→guard scan resolves `smoke §22`, `CUTOVER §1f`,
// `DB-REDESIGN §1c` and `PRESENCE §2`, plus bare tokens INSIDE the document
// that owns the numbering and same-line chains ("smoke §24 and §25"). Every
// other bare token is a finding, because a bare `§N` cannot say which
// document it means — and the same number exists in several of them.
//
// This pass applied that once, on 2026-09-27: for every bare token the
// scanner reported, it inserts the name of the document the token most
// plausibly means — the nearest preceding explicit name in the same file, or
// a unique section-set match — then the audit is expected to come back with
// no "names no document" findings. Run it again and it should find nothing.
//
//   node scripts/one-off/2026-09-27-rule-guards/sharpen.mjs [--dry]
//
// Exit 0 = nothing left to sharpen (or all decisions applied); it prints every
// decision so the diff can be reviewed file by file.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSources, collectSections, resolveCitationsIn } from '../../lib/rule-guards.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dry = process.argv.includes('--dry')

const sources = loadSources(root)
const sections = collectSections(sources)
const namedRe = /(smoke|CUTOVER|DB-REDESIGN|PRESENCE)(?:\.md)?[`'")\s]{0,2}§[\s]*(\d+[a-z]?)/gi
const canonical = { smoke: 'smoke', cutover: 'CUTOVER', 'db-redesign': 'DB-REDESIGN', presence: 'PRESENCE' }

let applied = 0
for (const doc of sources.docs) {
  const { findings } = resolveCitationsIn(doc.text, doc.path, sections)
  const bare = findings.filter((f) => f.kind === 'citation' && f.message.startsWith('citation: "'))
  if (!bare.length) continue

  const edits = []
  for (const f of bare) {
    const n = f.message.match(/"§([0-9]+[a-z]?)"/)[1]
    // Prefer the nearest explicit document name earlier in the same file: that
    // is what a reader does, and it is how the docs already talk ("…as
    // CUTOVER.md §1f says; the repair ran per §1f").
    let preceding = null
    for (const m of doc.text.matchAll(namedRe)) {
      if (m.index >= f.at) break
      preceding = canonical[m[1].toLowerCase()]
    }
    const candidates = Object.keys(sections).filter((d) => sections[d].has(n))
    // The nearest name wins only if it HAS that section (smoke §19 → the smoke
    // mention above it); when it does not and exactly one document does, the
    // section set is the better witness (CUTOVER §1f exists only in CUTOVER, however
    // many smoke sections were cited before it).
    const pick = (preceding && candidates.includes(preceding) && preceding) ||
      (candidates.length === 1 ? candidates[0] : null) ||
      preceding ||
      (candidates.includes('smoke') ? 'smoke' : null)
    if (!pick) {
      console.log(`SKIP  ${doc.path}:${f.line} §${n} — no document has that section; fix by hand`)
      continue
    }
    edits.push({ at: f.at, insert: pick + ' ', line: f.line, n, pick })
  }

  if (!edits.length) continue
  edits.sort((a, b) => b.at - a.at)
  let text = doc.text
  for (const e of edits) text = text.slice(0, e.at) + e.insert + text.slice(e.at)
  console.log(`${dry ? 'WOULD' : 'WROTE'} ${doc.path}: ${edits.length} token(s)`)
  for (const e of [...edits].reverse()) console.log(`   line ${e.line}: §${e.n} → ${e.pick} §${e.n}`)
  if (!dry) {
    writeFileSync(join(root, doc.path), text)
    applied += edits.length
  }
}

console.log(dry
  ? '\n(dry run — nothing written)'
  : applied ? `\n${applied} citation(s) sharpened` : '\nnothing left to sharpen')
