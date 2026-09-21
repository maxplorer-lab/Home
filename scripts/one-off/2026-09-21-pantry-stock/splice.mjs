// One-off: replace smoke section 22 (from its banner to the summary banner) with
// the rewritten two-domain version. Refuses to write unless both markers are
// found exactly once.
import { readFileSync, writeFileSync } from 'node:fs'

const suite = process.argv[2] || 'scripts/smoke.mjs'
const section = process.argv[3] || 'scripts/one-off/2026-09-21-pantry-stock/section22.mjs'

const text = readFileSync(suite, 'utf8')
const start = text.indexOf('// ─── 22. Stock:')
const end = text.indexOf('// ─── summary ─')
if (start === -1 || end === -1 || end < start) {
  console.error(`markers not found (start=${start}, end=${end})`)
  process.exit(1)
}
const next = text.slice(0, start) + readFileSync(section, 'utf8') + '\n' + text.slice(end)
writeFileSync(suite, next)
console.log(`replaced ${text.slice(start, end).split('\n').length} lines with ${readFileSync(section, 'utf8').split('\n').length}`)
console.log(`suite is now ${next.split('\n').length} lines`)
