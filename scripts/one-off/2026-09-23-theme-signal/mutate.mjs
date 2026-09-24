#!/usr/bin/env node
// ─── One theme signal: proof that §26 can fail ────────────────────────
// Falsification driver for the two guards `npm run smoke` §26 grew on
// 2026-09-23, when the tokens stopped answering the OS as well as the class.
//
// Why these two need one. The first guard FORBIDS something, and a check whose
// subject is an absence passes just as hard when it is looking in the wrong
// place — so it is paired with a positive control inside §26 (a synthetic
// source that must be flagged). The second guard asserts a bootstrap exists in
// three documents; if its list ever empties it reports a clean app forever.
// Each mutation below attacks one of them, alone:
//
//   M1  re-adds the prefers-color-scheme copy of the tokens
//   M2  removes the shell's dark bootstrap (tokens without the class)
//
//   node scripts/one-off/2026-09-23-theme-signal/mutate.mjs
//
// Needs a RUNNING dev server, because §26 reads the served documents rather than
// the sources — set BASE_URL (default http://127.0.0.1:8793). It runs the whole
// suite per mutation, so allow ~2× a normal run. Leaves the tree byte-identical,
// or it says so.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const rootPath = fileURLToPath(root)
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: files on disk are CRLF while every
// anchor below is written with a plain \n. Matching raw bytes misses the anchor
// — and a missed anchor is a SKIPPED mutation, which changes no code and still
// exits 0. So anchors match a normalised copy and write back with the ending the
// file already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8793'

const mutations = [
  {
    id: 'M1',
    file: 'src/views/app-chrome.tsx',
    why: 'a second, OS-driven copy of the dark tokens is back',
    guard: 'the dark palette answers the class only',
    from: '  html.dark {${DARK_TOKENS}  }',
    to: '  @media (prefers-color-scheme: dark) { :root {${DARK_TOKENS}    } }\n  html.dark {${DARK_TOKENS}  }',
  },
  {
    id: 'M2',
    file: 'src/views/shell.tsx',
    why: 'the shell ships the tokens but never sets the class they wait for',
    guard: 'every document that carries the tokens also sets the class',
    from: "            document.documentElement.classList.add('dark')",
    to: '            // (bootstrap removed for this probe)',
  },
]

// `wrangler dev` hot-reloads src/** on save; give it a beat and warm the worker
// so the suite never reads a document rendered from the previous module.
function settle() {
  sleepMs(1500)
  try {
    execSync(`curl -s -o /dev/null --max-time 20 ${BASE}/login`, { stdio: 'ignore', shell: true })
  } catch { /* the suite will report a dead server far more clearly */ }
}

function runSuite() {
  try {
    return execSync('npm run smoke', {
      cwd: rootPath, encoding: 'utf8', timeout: 600000,
      env: { ...process.env, BASE_URL: BASE },
    })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

let survived = 0
for (const m of mutations) {
  const original = normalized(m.file)
  const before = sha(m.file)
  if (!original.includes(m.from)) {
    console.log(`${m.id}  ANCHOR MISSING — ${m.from.slice(0, 60)}`)
    survived++
    continue
  }
  writeKeepingEol(m.file, original.replace(m.from, m.to))
  settle()
  let out
  try {
    out = runSuite()
  } finally {
    writeKeepingEol(m.file, original)
  }
  const restored = sha(m.file) === before
  const red = out.includes('✗') && new RegExp(`✗[^\\n]*${m.guard}`).test(out)
  console.log(`${m.id}  caught=${red ? 'YES' : 'NO '}  restored=${restored ? 'yes' : 'NO'}  (${m.why})`)
  if (!red || !restored) survived++
}

console.log(survived === 0
  ? '\nboth guards catch their own fault; tree restored'
  : `\n${survived} mutation(s) survived — a guard is decoration`)
process.exit(survived === 0 ? 0 : 1)
