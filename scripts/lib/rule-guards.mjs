// ─── The rule → guard map, read as data ──────────────────────────
// Answers ONE question about the documentation: **does every numbered rule
// in AGENTS.md declare a guard that exists, and does every guard reference
// in the repo still point at something real?**
//
// Why this exists. A rule's guard used to be a sentence in prose ("Smoke §15
// fails if…"), and a sentence cannot go stale loudly: rename a smoke section,
// delete a check, move a driver, and the promise reads exactly as well as it
// did the day it was written. The suite can check names; prose cannot. So the
// promises are DECLARED — one row per (rule, guard) edge in AGENTS.md — and
// this module reads them the way the module-state scan reads source code.
//
// What it resolves:
//
//   smoke §N              a section banner in scripts/smoke.mjs
//   smoke §N — "…"        …and a check-name fragment that must appear in it
//   audit:<script>        a package.json script, whose file must exist
//   driver <path>         a falsification driver file
//   none (convention)     nothing guards this rule; the count is printed
//
// Citations of § elsewhere in the repo are resolved too, because a section
// number is a contract (smoke's numbers especially). A citation is legal in
// three forms: qualified (`smoke §22`, `CUTOVER §1f`, `DB-REDESIGN §1c`,
// `PRESENCE §2`), bare INSIDE the document that owns the numbering (smoke.mjs
// owns smoke's; each numbered document owns its own), or bare as the second
// half of a same-line chain ("smoke §24 and §25"). Anything else is a finding
// — that is the ambiguity this scan exists to end.
//
// It reads files only. No server, no database, no network, so it runs in CI
// and inside the smoke suite's smoke §28 alike.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

// ── the vocabulary the map is written in ─────────────────────────
export const GUARD_KINDS = ['smoke', 'audit', 'driver', 'none']

// The document name may arrive inside backticks (`npm run smoke` §24,
// `CUTOVER.md` §1f), so up to two punctuation characters are allowed between
// the name and the token — enough for the closing quote, not enough to let a
// name from one clause resolve a token in the next.
const NAMED_NS = /(smoke|CUTOVER|DB-REDESIGN|PRESENCE)(?:\.md)?[`'")\s]{0,2}§[\s]*(\d+[a-z]?)/gi
const BARE_REF = /§[\s]*(\d+[a-z]?)/g
const AUDIT_REF = /audit:([a-z][a-z-]*)/g
const DRIVER_REF = /scripts\/one-off\/[A-Za-z0-9._/-]*mutate\.mjs/g
const RULE_HEADER = /^(\d+)\. /gm

/** The documents that own a § numbering, and the section ids they own. */
const OWNERS = {
  'scripts/smoke.mjs': 'smoke',
  'CUTOVER.md': 'CUTOVER',
  'DB-REDESIGN.md': 'DB-REDESIGN',
  'PRESENCE.md': 'PRESENCE',
}

/** `Smoke` and `smoke` are the same document; the section sets are keyed on
 * the canonical spelling. */
const CANONICAL_DOC = { smoke: 'smoke', cutover: 'CUTOVER', 'db-redesign': 'DB-REDESIGN', presence: 'PRESENCE' }

const SECTION_PATTERNS = {
  smoke: /^\/\/ ─── (\d+[a-z]?)\./gm,          // section banners in smoke.mjs
  CUTOVER: /^#{2,3} (\d+[a-z]?)\./gm,          // "## 1. …", "### 1f. …"
  'DB-REDESIGN': /^#{2,3} (\d+[a-z]?)\./gm,
  PRESENCE: /^#{2,3} (\d+[a-z]?)\./gm,
}

const MAP_HEADING = '## The rule → guard map'
const EXCUSED_HEADING = 'Sections that guard no numbered rule'

// ── reading the tree ─────────────────────────────────────────────
const CITED_EXTS = new Set(['.md', '.yml', '.mjs', '.ts', '.tsx'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.wrangler') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (CITED_EXTS.has(extname(entry.name))) out.push(full)
  }
  return out
}

/** Everything the scan reads, as text. Injectable so a fixture (smoke §28's
 * controls, the driver) can hand in a tree that exists only in memory. */
export function loadSources(root, { citations = true } = {}) {
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const sources = {
    root,
    agents: read('AGENTS.md'),
    smoke: read('scripts/smoke.mjs'),
    pkg: JSON.parse(read('package.json')),
    docs: [],
  }
  if (citations) {
    for (const file of walk(root)) {
      sources.docs.push({ path: relative(root, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') })
    }
  }
  return sources
}

// ── sections (the things guards and citations point at) ──────────
export function collectSections(sources) {
  const byDoc = {}
  for (const [doc, re] of Object.entries(SECTION_PATTERNS)) {
    const ownerPath = Object.keys(OWNERS).find((p) => OWNERS[p] === doc)
    const text = doc === 'smoke'
      ? sources.smoke
      : (sources.docs?.find((d) => d.path === ownerPath)?.text ?? '')
    byDoc[doc] = new Set([...text.matchAll(re)].map((m) => m[1]))
  }
  return byDoc
}

// ── citations ────────────────────────────────────────────────────
/** Resolve every § token in one file's text. Returns { refs, findings }:
 * a ref is `{ doc, n, raw }`; a finding is a token no rule can resolve. */
export function resolveCitationsIn(text, path, sections) {
  const refs = []
  const findings = []
  const owner = OWNERS[path]
  // Walk the text with its line separators kept, so every finding can carry
  // the ABSOLUTE character index of its token — the audit only needs the
  // message, but the one-off sharpening pass needs somewhere to insert the
  // document name.
  const parts = text.split(/(\r?\n)/)
  let offset = 0
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const lineNo = Math.floor(i / 2) + 1
    const explicit = []
    for (const m of line.matchAll(NAMED_NS)) {
      explicit.push({ at: m.index, doc: CANONICAL_DOC[m[1].toLowerCase()], n: m[2], raw: m[0] })
    }
    const events = explicit.map((e) => ({ at: e.at, kind: 'named', e }))
    for (const m of line.matchAll(BARE_REF)) {
      if (explicit.some((e) => e.at <= m.index && m.index < e.at + e.raw.length)) continue
      events.push({ at: m.index, kind: 'bare', e: { n: m[1], raw: m[0] } })
    }
    events.sort((a, b) => a.at - b.at)
    let lastDoc = null
    for (const ev of events) {
      if (ev.kind === 'named') lastDoc = ev.e.doc
      const doc = ev.kind === 'named' ? ev.e.doc : (lastDoc || owner)
      if (!doc) {
        findings.push({ kind: 'citation', path, file: path, at: offset + ev.at, line: lineNo, message: `citation: "${ev.e.raw}" at ${path}:${lineNo} names no document (write smoke §N / CUTOVER §N / DB-REDESIGN §N / PRESENCE §N)` })
        continue
      }
      if (sections[doc] && !sections[doc].has(ev.e.n)) {
        findings.push({ kind: 'citation', path, file: path, at: offset + ev.at, line: lineNo, message: `citation: ${doc} §${ev.e.n} at ${path}:${lineNo} does not exist` })
        continue
      }
      refs.push({ doc, n: ev.e.n })
    }
    offset += line.length + (parts[i + 1]?.length ?? 0)
  }
  return { refs, findings }
}

// ── the map (AGENTS.md) ──────────────────────────────────────────
function splitRow(line) {
  if (!line.trim().startsWith('|')) return null
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

/** Parse the declared map: one row per (rule, guard) edge, plus the excused
 * sections table. Tolerant of the doc's two rule formats; strict about the
 * table's own cells. */
export function parseRuleMap(agents) {
  const rules = new Map()
  const headerRe = new RegExp(RULE_HEADER.source, 'gm')
  let m
  const starts = []
  while ((m = headerRe.exec(agents))) starts.push({ n: Number(m[1]), at: m.index })
  // A rule's block stops at the next rule, and the LAST rule stops at the map:
  // otherwise it would extend to EOF and "claim" every § token in the table,
  // the smoke-test section and the troubleshooting map below it.
  const rosterEnd = agents.indexOf(MAP_HEADING)
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : (rosterEnd === -1 ? agents.length : rosterEnd)
    const body = agents.slice(starts[i].at, end)
    const firstLine = body.split(/\r?\n/)[0].replace(/^\d+\.\s*/, '')
    rules.set(starts[i].n, { n: starts[i].n, title: firstLine, body })
  }

  const mapAt = agents.indexOf(MAP_HEADING)
  const excusedAt = agents.indexOf(EXCUSED_HEADING)
  const tableText = mapAt === -1 ? '' : agents.slice(mapAt, excusedAt === -1 ? agents.length : excusedAt)
  const excusedText = excusedAt === -1 ? '' : agents.slice(excusedAt)

  const rows = []
  for (const line of tableText.split(/\r?\n/)) {
    const cells = splitRow(line)
    if (!cells || cells.length < 4) continue
    if (cells[0] === 'Rule' || /^-+$/.test(cells[0])) continue
    if (!/^\d+$/.test(cells[0])) continue
    rows.push({ rule: Number(cells[0]), slug: cells[1], guard: cells[2], falsifier: cells[3] })
  }
  const excused = []
  for (const line of excusedText.split(/\r?\n/)) {
    const cells = splitRow(line)
    if (!cells || cells.length < 2) continue
    if (/^Section$/i.test(cells[0]) || /^-+$/.test(cells[0])) continue
    const mm = cells[0].match(/^smoke\s*§\s*(\d+[a-z]?)$/i)
    if (mm) excused.push({ section: mm[1], reason: cells[1] })
  }
  return { rules, rows, excused }
}

// ── guard refs in prose and in the table ─────────────────────────
/** The guard-shaped tokens a text names: smoke sections, audits, drivers.
 * (CUTOVER/DB-REDESIGN/PRESENCE citations are references, not guards.) */
export function guardTokensIn(text, path, sections) {
  const tokens = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line) => {
    const { refs, findings } = resolveCitationsIn(line, path, sections)
    for (const r of refs) if (r.doc === 'smoke') tokens.push(`smoke §${r.n}`)
    for (const m of line.matchAll(AUDIT_REF)) tokens.push(`audit:${m[1]}`)
    for (const m of line.matchAll(DRIVER_REF)) tokens.push('driver ' + m[0])
    void findings
  })
  return tokens
}

function resolveGuard(cell, sources, sections, pkg, findings, rule) {
  const none = /^none \(convention\)$/i.test(cell)
  if (none) return { kind: 'none' }
  const smoke = cell.match(/^smoke\s*§\s*(\d+[a-z]?)(?:\s*[—-]\s*"([^"]*)")?$/i)
  if (smoke) {
    if (!sections.smoke.has(smoke[1])) {
      findings.push({ kind: 'guard', rule, message: `rule ${rule}: guard "smoke §${smoke[1]}" does not resolve — no such section in scripts/smoke.mjs` })
      return null
    }
    if (smoke[2] && !sources.smoke.includes(smoke[2])) {
      findings.push({ kind: 'guard', rule, message: `rule ${rule}: guard "smoke §${smoke[1]}" promises a check containing "${smoke[2]}", which scripts/smoke.mjs does not contain` })
      return null
    }
    return { kind: 'smoke', doc: 'smoke', n: smoke[1], fragment: smoke[2] || null }
  }
  const audit = cell.match(/^audit:([a-z][a-z-]*)$/i)
  if (audit) {
    // The cell names the SCRIPT, so the lookup key carries the prefix too:
    // package.json holds `"audit:module-state": "node scripts/…mjs"`, and
    // looking up the bare suffix resolved nothing at all — every row of this
    // kind would have read as a missing script.
    const name = audit[1]
    const script = pkg.scripts && pkg.scripts['audit:' + name]
    if (!script) {
      findings.push({ kind: 'guard', rule, message: `rule ${rule}: guard "audit:${name}" does not resolve — no such script in package.json` })
      return null
    }
    const file = script.match(/node\s+(\S+\.mjs)/)
    if (file && !existsSync(join(sources.root, file[1]))) {
      findings.push({ kind: 'guard', rule, message: `rule ${rule}: guard "audit:${name}" points at ${file[1]}, which does not exist` })
      return null
    }
    return { kind: 'audit', name }
  }
  const driver = cell.match(/^driver\s+(\S+)$/i)
  if (driver) {
    if (!existsSync(join(sources.root, driver[1]))) {
      findings.push({ kind: 'guard', rule, message: `rule ${rule}: falsifier "${driver[1]}" does not exist` })
      return null
    }
    return { kind: 'driver', path: driver[1] }
  }
  findings.push({ kind: 'guard', rule, message: `rule ${rule}: guard cell "${cell}" is not one of smoke §N / audit:<script> / none (convention)` })
  return null
}

// ── the scan ─────────────────────────────────────────────────────
export function scanRuleGuards(sources) {
  const findings = []
  const sections = collectSections(sources)
  const { rules, rows, excused } = parseRuleMap(sources.agents)

  // 1. numbering: every rule 1..N exactly once, in order
  const numbers = [...rules.keys()]
  const expected = numbers.map((_, i) => i + 1)
  if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
    findings.push({ kind: 'rules', message: `rules: numbered rules are ${numbers.join(', ')} — expected 1..${numbers.length} in order (a gap renumbers every citation behind it)` })
  }
  const byRule = new Map()
  for (const row of rows) {
    if (!byRule.has(row.rule)) byRule.set(row.rule, [])
    byRule.get(row.rule).push(row)
  }
  for (const n of numbers) {
    const mine = byRule.get(n)
    if (!mine) {
      findings.push({ kind: 'rules', rule: n, message: `rule ${n}: no row in the rule→guard map (declare a guard, or "none (convention)")` })
      continue
    }
    const slugs = new Set(mine.map((r) => r.slug))
    if (slugs.size > 1) findings.push({ kind: 'rules', rule: n, message: `rule ${n}: its rows disagree on the slug ("${[...slugs].join('" / "')}")` })
    if (mine.some((r) => /^none \(convention\)$/i.test(r.guard)) && mine.some((r) => !/^none \(convention\)$/i.test(r.guard))) {
      findings.push({ kind: 'rules', rule: n, message: `rule ${n}: "none (convention)" sits beside a real guard — remove one` })
    }
  }
  for (const row of rows) {
    if (!rules.has(row.rule)) findings.push({ kind: 'rules', rule: row.rule, message: `rule ${row.rule}: a row exists but there is no rule ${row.rule} in AGENTS.md` })
  }

  // 2. guards resolve, and the rule's prose never claims one the rows omit
  for (const [n, rowsOfRule] of byRule) {
    if (!rules.has(n)) continue
    const table = new Set()
    const falsifiers = []
    for (const row of rowsOfRule) {
      const g = resolveGuard(row.guard, sources, sections, sources.pkg, findings, n)
      if (g && g.kind !== 'none') table.add(g.kind === 'smoke' ? `smoke §${g.n}` : g.kind === 'audit' ? `audit:${g.name}` : 'driver ' + g.path)
      if (row.falsifier && row.falsifier !== '—' && row.falsifier !== '-') {
        const f = resolveGuard(row.falsifier, sources, sections, sources.pkg, findings, n)
        if (f && f.kind === 'driver') { falsifiers.push(f.path); table.add('driver ' + f.path) }
      }
    }
    const prose = guardTokensIn(rules.get(n).body, 'AGENTS.md', sections)
    for (const token of new Set(prose)) {
      if (!table.has(token)) {
        findings.push({ kind: 'prose', rule: n, message: `rule ${n}: prose names "${token}" but no row in the map declares it` })
      }
    }
  }

  // 3. every § citation in the repo resolves, and names its document
  for (const doc of sources.docs) {
    const { findings: citeFindings } = resolveCitationsIn(doc.text, doc.path, sections)
    findings.push(...citeFindings)
  }

  // 4. census: every smoke section is claimed by a rule row or excused
  const claimed = new Set()
  for (const row of rows) {
    const m = row.guard.match(/^smoke\s*§\s*(\d+[a-z]?)/i)
    if (m) claimed.add(m[1])
  }
  const excusedSet = new Set(excused.map((e) => e.section))
  for (const n of sections.smoke) {
    if (!claimed.has(n) && !excusedSet.has(n)) {
      findings.push({ kind: 'census', message: `smoke §${n}: neither claimed by a rule nor listed as excused` })
    }
    if (claimed.has(n) && excusedSet.has(n)) {
      findings.push({ kind: 'census', message: `smoke §${n}: claimed by a rule AND excused — remove one` })
    }
  }
  return findings
}

export function formatRuleFindings(findings) {
  return findings.map((f) => f.message)
}

/** The map as data, for `--print` and for the census numbers. */
export function deriveMap(sources) {
  const sections = collectSections(sources)
  const { rules, rows, excused } = parseRuleMap(sources.agents)
  const byRule = new Map()
  for (const row of rows) {
    if (!byRule.has(row.rule)) byRule.set(row.rule, [])
    byRule.get(row.rule).push(row)
  }
  return {
    rules: [...rules.values()].map((r) => ({
      n: r.n,
      slug: byRule.get(r.n)?.[0]?.slug ?? null,
      guards: byRule.get(r.n)?.map((row) => row.guard) ?? [],
      prose: [...new Set(guardTokensIn(r.body, 'AGENTS.md', sections))],
    })),
    excused,
    sections: [...sections.smoke].sort((a, b) => parseInt(a) - parseInt(b)),
    noneCount: rows.filter((r) => /^none \(convention\)$/i.test(r.guard)).length,
    ruleCount: rules.size,
  }
}
