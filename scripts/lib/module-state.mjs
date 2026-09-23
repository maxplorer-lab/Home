// ─── Module-scope state analyzer ────────────────────────────────
// Finds REQUEST DATA CARRIED THROUGH MODULE SCOPE instead of a parameter.
//
// Why this exists. One Worker isolate serves many requests and interleaves
// them at every `await`, so a module-scope binding that a request WRITES is
// shared mutable state between unrelated people. `src/identity.ts` shipped
// exactly that: a module-level `lastPassword` that a login set before
// provisioning and cleared in a `finally`, with several D1 round-trips in
// between. Two overlapping logins could interleave those awaits, and the
// second request's password was hashed into the first one's freshly created
// row — in W.A.Y that hash doubles as the μlogger Basic-Auth credential, so
// the swap hands one person's phone credential to another account.
//
// The fix threaded the password in as a parameter, which removes the
// possibility rather than the occurrence. THIS is what keeps it removed: the
// class has no syntax that fails a build, no lint rule in this repo, and no
// runtime symptom until two requests happen to overlap — so it needs a check
// that reads the code and a guard that reads the check.
//
// What counts as a fault is deliberately narrow, because the alternative
// (flagging every module-scope binding) would be noise nobody keeps:
//   * reading module state from anywhere is FINE — `const CONFIG = {…}` read by
//     a thousand requests is correct and is not reported
//   * what is reported is a WRITE reachable from a function body: reassigning
//     a module binding, writing through it (`CACHE[k] = v`, `state.user = u`),
//     or calling a mutator on it (`CACHE.set`, `LIST.push`)
//   * a binding declared at module scope is only module scope if the SOURCE
//     FILE declares it. A `let` inside a function is not this class, and a
//     top-level block's `let` is unreachable from a function, so neither is
//     reported.
//
// It runs on the TypeScript compiler API rather than a regex on purpose: this
// question ("is this identifier the same binding?") is scope resolution, and a
// regex answers it wrong in both directions — it misses a write through a
// differently-named alias and it invents a fault for a shadowed local.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, extname, relative, isAbsolute } from 'node:path'

// This file lives at <repo>/scripts/lib/, so the repo root is two levels up.
// Everything below is resolved from THERE rather than from `process.cwd()`:
// the suite and the audit are run from the repo root by convention, but a
// dependency on that convention turns "ran from the wrong folder" into a
// crash rather than a finding.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist'])
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']

/** Methods that change a container's CONTENTS without rebinding it. The
    binding never changes, so a scope-only analysis would call this clean. */
const MUTATORS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill',
  'copyWithin', 'set', 'add', 'delete', 'clear',
])

function collectFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else if (EXTENSIONS.includes(extname(name))) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Analyze in-memory or on-disk sources.
 *
 * `root`         directory to walk for real files (string).
 * `extraSources` optional [{ path, text }] analyzed as if they were files in
 *                the tree — the synthetic controls use this, so `smoke` can
 *                prove the analyzer notices a fault it is not currently
 *                looking at (a scanner whose input silently empties reports a
 *                green tree forever).
 *
 * Returns an array of findings:
 *   { file, line, name, declaredAs, wroteAt, how, kind }
 * where `kind` is 'reassigned' | 'mutated' | 'written-through'.
 */
export function scanModuleState({ root, extraSources = [] } = {}) {
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const ts = require('typescript')

  // Node kinds whose body is a separate execution context: a write inside one of
  // these is what makes a module binding shared state. Built from `ts` because
  // these are compares-against-`node.kind` NUMBERS -- a set of kind NAMES never
  // matches anything, which leaves `inside` permanently false and makes this
  // whole scan report a clean tree without looking at a single function.
  const FUNCTION_KINDS = new Set([
    ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
  ])

  const sources = []
  if (root) {
    const base = isAbsolute(root) ? root : join(REPO_ROOT, root)
    for (const path of collectFiles(base)) sources.push({ path, text: readFileSync(path, 'utf8') })
  }
  for (const s of extraSources) sources.push(s)

  const findings = []

  for (const { path, text } of sources) {
    const kind = extname(path) === '.tsx' ? ts.ScriptKind.TSX
      : extname(path) === '.ts' ? ts.ScriptKind.TS
        : ts.ScriptKind.JS
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)

    // ── module scope: declared directly by the file (or a namespace) ──
    const bindings = new Map()
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        const declaredAs = (stmt.declarationList.flags & ts.NodeFlags.Const) ? 'const'
          : (stmt.declarationList.flags & ts.NodeFlags.Let) ? 'let' : 'var'
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            bindings.set(d.name.text, { node: d.name, declaredAs })
          }
        }
      } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
        bindings.set(stmt.name.text, {
          node: stmt.name,
          declaredAs: ts.isClassDeclaration(stmt) ? 'class' : 'function',
        })
      }
    }
    if (bindings.size === 0) continue

    const file = root ? relative(REPO_ROOT, path).replace(/\\/g, '/') : path
    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

    const walk = (node, inFunction) => {
      const inside = inFunction || FUNCTION_KINDS.has(node.kind)

      const report = (target, how) => {
        if (!inside) return
        if (ts.isIdentifier(target) && bindings.has(target.text)) {
          const b = bindings.get(target.text)
          findings.push({
            file, line: lineOf(b.node), name: target.text, declaredAs: b.declaredAs,
            wroteAt: lineOf(target), how, kind: how === 'called a mutator on' ? 'mutated' : 'reassigned',
          })
        } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
          const base = target.expression
          if (ts.isIdentifier(base) && bindings.has(base.text)) {
            const b = bindings.get(base.text)
            findings.push({
              file, line: lineOf(b.node), name: base.text, declaredAs: b.declaredAs,
              wroteAt: lineOf(target), how, kind: 'written-through',
            })
          }
        }
      }

      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        report(node.left, 'assigned')
      } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
          report(node.operand, 'incremented')
        }
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (MUTATORS.has(node.expression.name.text)) {
          report(node.expression.expression, 'called a mutator on')
        }
      }

      ts.forEachChild(node, (child) => walk(child, inside))
    }
    walk(sf, false)
  }

  return findings
}

/** One line per finding, with a distinct line per write site, so a failure
    message names the file, the binding and every place it is written. */
export function formatFindings(findings) {
  const groups = new Map()
  for (const f of findings) {
    const key = `${f.file}:${f.line} ${f.name}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  const lines = []
  for (const [key, group] of groups) {
    const first = group[0]
    lines.push(`${key} [${first.declaredAs}]  written from inside a function at ` +
      group.map((g) => `${g.wroteAt} (${g.how})`).join(', '))
  }
  return lines
}
