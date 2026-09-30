// ─── The type pass over Home's JavaScript ────────────────────────
// Answers ONE question: does every `.js` file under `src/` typecheck under a
// DECLARED, pinned option set?
//
// Why this exists. `tsconfig.json` is `strict` over `include: ["src"]` with
// `checkJs: false`, so Laoka's vendored JavaScript — 17 files under
// `src/laoka/` — sat INSIDE the include and OUTSIDE the gate: the compiler
// parsed those files (they are imported by `src/laoka/worker.ts`), said nothing
// about them, and no line of AGENTS.md mentioned it. Two other scans in this
// repo already read them (`scanModuleState` parses every `.js` for a
// module-scope write, and the DO audit reads `Lobby` out of `wrangler.jsonc`);
// the TYPE gate was the one that stopped at the extension.
//
// What looking costs. With `checkJs: true` under the project's own settings the
// same 3192 lines report 321 faults — 285 of them parameters with no
// annotation, which is simply the price of full strictness on untyped
// JavaScript (the directory carries no JSDoc at all). Silence `noImplicitAny`
// ALONE and ten remain, every one of them a shape worth fixing: eight
// `err.message` reads off a caught `unknown` (the catch binding is `unknown`
// under `strict`), one inferred result whose `value` could be absent, one
// route-table overload that cannot unify seven module-scoped arrays.
//
// So the pass is checked with exactly ONE relaxation — and the relaxation is
// PINNED rather than assumed. `scanLaokaTypes` asserts its own effective option
// set (strict, strictNullChecks, noImplicitThis, useUnknownInCatchVariables and
// the rest all ON; only noImplicitAny off) and REFUSES TO ANSWER when any of
// them has moved, because this is the easiest scanner in the repo to loosen by
// accident: the flags it does not want are the ones it inherits from
// tsconfig.json, and a pass that has been quietly relaxed prints a clean tree
// for the rest of the project's life.
//
// The checked set is every `.js`/`.mjs`/`.cjs` under `src/` — not a declared
// list of paths — so a new file is inside the gate the moment it lands rather
// than the day somebody remembers to add it. `public/` is deliberately OUT of
// scope: those files are browser scripts (they want `window`, the DOM lib and a
// declaration of the engines' `window.Home*` globals), and smoke §15 already
// executes the engine files the page loads.
//
// It reads files and runs the TypeScript compiler. No server, no database, no
// network, so it gates CI and runs inside the smoke suite (smoke §29) alike.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, isAbsolute, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHECKED_EXTENSIONS = ['.js', '.mjs', '.cjs']
const CHECKED_ROOT = 'src'

/** File names are compared through this key EVERYWHERE in this module: the
 * compiler returns them with forward slashes (and its own case) while `join`
 * hands back what this checkout calls them. Comparing the raw strings filtered
 * every diagnostic out on Windows once, and missed the fixture host's map
 * another time — both variants of a scan that reads nothing. */
const keyOf = (p) => {
  const slashed = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** The option set this pass is allowed to run under, as declared. Only
 * `noImplicitAny` is off, and it is off ONLY here: see the header. */
export const PINNED_OPTIONS = {
  checkJs: true,
  allowJs: true,
  strict: true,
  strictNullChecks: true,
  useUnknownInCatchVariables: true,
  noImplicitThis: true,
  strictFunctionTypes: true,
  alwaysStrict: true,
  //…the one relaxation. Everything above must stay on, or the scan refuses.
  noImplicitAny: false,
}

/** The flags `strict` implies, when they are not spelled out. Effective value =
 * the flag itself if it is set, else the value of `strict` — the compiler's own
 * rule, spelled out here so the pin cannot be read wrong. */
const STRICT_FAMILY = [
  'strictNullChecks', 'useUnknownInCatchVariables', 'noImplicitThis',
  'strictFunctionTypes', 'alwaysStrict', 'noImplicitAny',
]

function effectiveOption(options, key) {
  if (!STRICT_FAMILY.includes(key)) return options[key] === true
  const own = options[key]
  if (own !== undefined) return own === true
  return options.strict === true
}

/** Every `.js`/`.mjs`/`.cjs` under `<root>/src`, absolute paths, sorted. */
export function collectJsFiles(root) {
  const base = join(root, CHECKED_ROOT)
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.wrangler') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (CHECKED_EXTENSIONS.includes(extname(entry.name))) out.push(full)
    }
  }
  walk(base)
  return out.sort()
}

/** The options this pass runs under: the project's own, with the one declared
 * relaxation applied. Everything else comes from tsconfig.json on purpose — the
 * pass is meant to differ from `npm run check` in exactly one way. */
function passOptions(ts, root) {
  const configPath = join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(`tsconfig.json unreadable: ${ts.flattenDiagnosticMessageText(config.error.messageText, ' ')}`)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  return { ...parsed.options, checkJs: true, noImplicitAny: false }
}

/** A compiler host that serves the fixture sources the controls hand in. The
 * smoke section's whole point is to prove the scan can still fail on a fault it
 * is not currently looking at, so the fixtures must be TYPECHECKED, not just
 * parsed — which means they have to be files the program can see. */
function hostedWithExtras(ts, options, extras) {
  const host = ts.createCompilerHost(options)
  // Keyed by the same normalising key as everything else: the compiler hands
  // the host forward-slashed file names, and a map keyed by what `join` called
  // them misses every lookup — the fixture then never enters the program, and
  // the census says so instead of a check quietly passing on nothing.
  const sources = new Map(extras.map((e) => [keyOf(e.path), e.text]))
  const base = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile }
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = sources.get(keyOf(fileName))
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.JS)
    return base.getSourceFile(fileName, languageVersion, onError, shouldCreate)
  }
  host.fileExists = (fileName) => sources.has(keyOf(fileName)) || base.fileExists(fileName)
  host.readFile = (fileName) => sources.get(keyOf(fileName)) ?? base.readFile(fileName)
  return host
}

/**
 * Typecheck the checked set.
 *
 * `root`          repo root to scan (defaults to this module's repo).
 * `extraSources`  `{ path, text }` fixtures to check ALONGSIDE the tree — paths
 *                 relative to the root. The controls use them; a fixture is
 *                 never written to disk.
 * `optionsPatch`  deliberately overrides the pinned flags, so a control can
 *                 prove a loosened pass is REFUSED rather than trusted.
 *
 * Returns findings: `{ kind, file, line, column, code, message }`, where `kind`
 * is 'options' (the pin moved — reported first, and nothing else is answered),
 * 'syntax' or 'type'.
 */
export function scanLaokaTypes({ root = REPO_ROOT, extraSources = [], optionsPatch = {} } = {}) {
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const ts = require('typescript')

  const options = { ...passOptions(ts, root), ...optionsPatch }

  // The pin comes FIRST: a pass whose relaxation grew cannot be trusted to
  // answer the question, so it says so instead of reporting a clean tree.
  const findings = []
  for (const [key, want] of Object.entries(PINNED_OPTIONS)) {
    const got = effectiveOption(options, key)
    if (got !== want) {
      findings.push({
        kind: 'options',
        file: 'tsconfig.json',
        line: 0,
        column: 0,
        code: 'PINNED',
        message: `the pass runs with ${key}: ${got} — the declared set says ${want}. This pass may relax noImplicitAny and nothing else; a check that has been quietly loosened reports a clean tree forever`,
      })
    }
  }
  if (findings.length) return findings

  const files = collectJsFiles(root)
  const extras = extraSources.map((s) => ({ path: isAbsolute(s.path) ? s.path : join(root, s.path), text: s.text }))
  const program = ts.createProgram([...files, ...extras.map((e) => e.path)], options, hostedWithExtras(ts, options, extras))

  // File names are compared through a normalising key on purpose. The compiler
  // returns them with forward slashes (and its own case) while `join` hands back
  // what this checkout calls them; comparing the raw strings filtered EVERY
  // diagnostic out on Windows, so the scan reported a clean tree about ten
  // faults it had actually found. That is the failure mode this whole file is
  // written against — a check that quietly reads nothing — so the census below
  // fails loudly if a checked file never reaches the program.
  const checked = new Set([...files, ...extras.map((e) => e.path)].map(keyOf))
  const inProgram = new Set(program.getSourceFiles().map((sf) => keyOf(sf.fileName)))
  const neverRead = [...checked].filter((k) => !inProgram.has(k))
  if (neverRead.length) {
    findings.push({
      kind: 'census',
      file: relative(root, files[0] || root).replace(/\\/g, '/'),
      line: 0,
      column: 0,
      code: 'CENSUS',
      message: `${neverRead.length} of ${checked.size} checked file(s) never reached the compiler's program (${neverRead.slice(0, 2).join(', ')}) — a clean tree from a scan that read nothing is not an answer`,
    })
    return findings
  }

  const report = (diags, kind) => {
    for (const d of diags) {
      if (!d.file || !checked.has(keyOf(d.file.fileName))) continue
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
      findings.push({
        kind,
        file: relative(root, d.file.fileName).replace(/\\/g, '/'),
        line: line + 1,
        column: character + 1,
        code: `TS${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      })
    }
  }
  report(program.getSyntacticDiagnostics(), 'syntax')
  report(program.getSemanticDiagnostics(), 'type')
  return findings
}

export function formatLaokaFindings(findings) {
  return findings.map((f) => `${f.file}:${f.line}:${f.column} ${f.code} ${f.message}`)
}

/** The checked set as data, for `--print` and for the audit's summary line. */
export function describeCheckedSet(root = REPO_ROOT) {
  const files = collectJsFiles(root)
  let lines = 0
  for (const file of files) lines += readFileSync(file, 'utf8').split(/\r?\n/).length - 1
  return { files: files.map((f) => relative(root, f).replace(/\\/g, '/')), lines }
}
