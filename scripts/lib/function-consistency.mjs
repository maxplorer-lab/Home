// ─── Function consistency & stability analyzer ──────────────────
//
// Answers ONE question about every function the app ships: **is a call that
// can fail or can be rejected actually carried somewhere?**
//
// Why this exists. The three faults below all compile, all type-check, and all
// look like ordinary code, and each one turns a real failure into nothing at
// all:
//
//   floating-async   an async call used as a statement. Its rejection becomes an
//                    unhandled rejection (a Worker may be torn down mid-flight),
//                    and the code after it runs as if the work had happened.
//   empty-catch      `catch (e) {}` — the failure is discarded where nobody can
//                    read it. A silent catch is sometimes right (the intake's
//                    gate counter must never upgrade a clean drop to a throw);
//                    then it carries a comment saying so, and the comment is the
//                    thing this check asks for.
//   async-callback   `await` (or an `async` callback) inside forEach/map/filter/
//                    some/every/find. These five call the callback and move on:
//                    the awaits are graded in the background, a rejection inside
//                    one is unhandled, and `filter`/`some`/`every` take a
//                    Promise as a boolean, which is always true.
//
// Everything is DECLARED. An intentional bare call is an entry in
// `FUNCTION_POLICY` with the reason it is intentional; an entry that stops
// matching anything is itself a fault (`stale-exception`), so an exception
// cannot quietly outlive the code it excused — the same shape as
// `do-state.mjs`'s field registry and `module-state.mjs`'s write scan.
//
// Scope is the whole shipped tree, not just the Worker: `src/` (the Worker and
// the SSR pages), `public/**.js` (the pages and the shared engines) and the
// inline `<script>` blocks of `public/**.html`. A floating promise on a phone's
// dashboard is exactly as real as one in a route handler, and the pages are
// where most of this app's functions live.
//
// It is READ-ONLY: it parses sources and writes nothing, so it is safe to run
// anywhere, and it exits 1 on a finding so it can gate a release.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, extname, relative, isAbsolute } from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// The compiler, resolved from the repo's own node_modules — the same one
// `npm run check` uses, so the analyzer and the type gate read one language.
const require = createRequire(join(REPO_ROOT, 'package.json'))
const ts = require('typescript')

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist'])
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html']

/**
 * Every intentional bare call and every silent catch, with the reason.
 *
 * `match` is `{ file?, callee?, code }` — file and callee are compared as
 * written (a path relative to the repo root with forward slashes, a callee's own
 * name). An entry that matches nothing in the tree is a `stale-exception`
 * fault, which is what keeps this list from becoming a graveyard of excuses.
 */
export const FUNCTION_POLICY = [
  // (empty by design: the app currently has no intentional bare call or silent
  //  catch that the checks below would flag. An entry here is a DECISION, and
  //  its stated reason is what a reader weighs — so an entry arrives with the
  //  code it excuses, and leaves when that code does.)
]

/** Calls that are async by contract rather than by their own declaration. */
const ASYNC_BY_CONTRACT = new Set(['fetch'])

/** The array methods that will not wait for an async callback. */
const SYNC_CALLBACKS = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find'])

/** Calls that mean "this try block touches something that can genuinely fail"
 *  (a request, a D1/DO statement). Used to keep the empty-catch check on the
 *  catches that HIDE information, rather than on the idiomatic best-effort ones
 *  (a localStorage write, a cache read) where silence is the contract. */
const IO_CALLS = new Set(['fetch', 'prepare', 'batch', 'all', 'first', 'run', 'send', 'json', 'text'])

/** The ways a page can tell a PERSON that something failed. A rejection net that
 *  only writes to the console is not a net: nobody holding a phone opens one. */
const NOTIFIERS = new Set(['alert', 'toast', 'reportError', 'setMsg', 'showError', 'fail', 'notice'])

/** Does this chunk install a rejection net — an `unhandledrejection` listener
 *  whose handler reports through one of NOTIFIERS? A page that has one carries
 *  the rejections nobody awaited (the DOM invokes its callbacks and drops the
 *  result, so an onclick handler has no caller left to catch it), and the audit
 *  reports those as covered rather than as faults, so how much rests on the net
 *  stays countable instead of invisible. */
function rejectionNet(sf) {
  let found = false
  const handlerNotifies = (fn) => {
    let hit = false
    const visit = (n) => {
      if (hit) return
      if (ts.isCallExpression(n)) {
        const name = calleeName(n)
        if (name && NOTIFIERS.has(name)) { hit = true; return }
      }
      ts.forEachChild(n, visit)
    }
    visit(fn)
    return hit
  }
  const visit = (n) => {
    if (found) return
    // window.addEventListener('unhandledrejection', function (ev) { … })
    if (ts.isCallExpression(n) && calleeName(n) === 'addEventListener') {
      const [type, handler] = n.arguments
      if (type && ts.isStringLiteral(type) && type.text === 'unhandledrejection'
        && handler && ts.isFunctionLike(handler) && handlerNotifies(handler)) {
        found = true
        return
      }
    }
    // window.onunhandledrejection = function (ev) { … }
    if (ts.isBinaryExpression(n)
      && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'onunhandledrejection'
      && ts.isFunctionLike(n.right) && handlerNotifies(n.right)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

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
 * The JavaScript a file actually runs: for an HTML page, each inline <script>
 * block; for a module, the file itself. Each chunk carries the line the chunk
 * STARTS on, so a finding in a page's script 3400 lines down reports the line a
 * reader can open, not the line inside the chunk.
 */
export function scriptChunks(path, text) {
  if (extname(path) !== '.html') return [{ text, startLine: 1 }]
  const chunks = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(text))) {
    if (/\bsrc\s*=/.test(m[1])) continue // an external file is scanned as itself
    if (/\btype\s*=\s*["']?(application\/json|importmap|text\/template)/i.test(m[1])) continue
    const before = text.slice(0, m.index + m[0].indexOf('>') + 1)
    chunks.push({ text: m[2], startLine: before.split('\n').length })
  }
  return chunks
}

function scriptKindOf(path) {
  const ext = extname(path)
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.ts') return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/** The name a call site uses: `f()` → f, `a.b()` → b, `a[b]()` → null. */
function calleeName(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return null
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  // `this.ctx.waitUntil(…)` and `stub.fetch(…)` both name the method that runs.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

/** Does this subtree contain an `await` that belongs to IT (not to a nested
 *  function, whose awaits are graded by whoever calls that function)? */
function containsOwnAwait(node) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isFunctionLike(n) && n !== node) return // a nested function's awaits are its own
    if (ts.isAwaitExpression(n)) { found = true; return }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/** Does this try block contain work whose failure a reader would want named?
 *  An `await`, or a call to something that speaks to another machine. The
 *  distinction is the whole point of the check: `try { localStorage.setItem(…) }
 *  catch {}` throws away nothing anybody could act on, while `try { await
 *  fetch(…) } catch {}` throws away the reason a screen stayed empty. */
function tryBlockCanFailMeaningfully(block) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isAwaitExpression(n)) { found = true; return }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (name && IO_CALLS.has(name)) { found = true; return }
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(block, visit)
  return found
}

const FN_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
])

/**
 * Analyze every function under `root`.
 *
 * Returns { functions, faults } — `functions` is the inventory (a count per
 * file, so a scan that silently stopped finding functions is visible as a
 * smaller number instead of a clean report), `faults` the findings.
 *
 * `extraSources` and `policy` exist for the CONTROLS that keep this honest
 * (smoke §30): a checker only ever pointed at a clean tree cannot show it would
 * notice a fault. Nothing in the shipped path passes them.
 */
export function scanFunctions({
  root = null,
  roots = ['src', 'public'],
  extraSources = [],
  policy = FUNCTION_POLICY,
  paths,
} = {}) {
  const faults = []
  const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/')
  const dirs = root ? [root] : roots
  const files = (paths
    ?? dirs.flatMap((d) => collectFiles(isAbsolute(d) ? d : join(REPO_ROOT, d)))
  ).filter((p) => existsFile(p))

  // ── parse everything first ──
  const parsed = []
  for (const path of files) {
    const text = readFileSync(path, 'utf8')
    for (const chunk of scriptChunks(path, text)) {
      if (!chunk.text.trim()) continue
      parsed.push({
        path,
        chunk,
        sf: ts.createSourceFile(path, chunk.text, ts.ScriptTarget.Latest, true, scriptKindOf(path)),
      })
    }
  }
  for (const s of extraSources) {
    parsed.push({
      path: s.path, chunk: { startLine: 1 },
      sf: ts.createSourceFile(s.path, s.text, ts.ScriptTarget.Latest, true, scriptKindOf(s.path)),
    })
  }

  // ── which names are async, and can they reject? ──
  // Collected across the tree, because a call site rarely sits in the same file
  // as the declaration it depends on (`showAlert`, `refreshLaokaExpense`, the
  // shared engines). Over-approximating the set would make this noisy, so a name
  // counts only when a function of that name is DECLARED async — plus the
  // handful of calls that are async by contract.
  //
  // `guarded` is what keeps the check about OUTCOMES rather than style: an
  // async function whose own body wraps its work in try/catch (the idiom this
  // app uses on every page — `loadHistory`, `softRefresh`, `deleteHistory`) has
  // nowhere to reject TO, so calling it bare costs nothing. The fault is an
  // async call that can reject into a caller that cannot catch it.
  const asyncInfo = new Map()
  // A name that is ALSO declared by a synchronous function cannot be resolved by
  // name alone: `map.delete(…)` and an `async delete()` somewhere in the tree
  // share a spelling and nothing else. Flagging those is a coin flip, so an
  // ambiguous name is skipped rather than guessed at — a smaller honest list
  // beats a longer wrong one.
  const syncNames = new Set()
  for (const name of ASYNC_BY_CONTRACT) asyncInfo.set(name, { guarded: false })
  for (const { sf } of parsed) {
    const visit = (node) => {
      if (FN_KINDS.has(node.kind)) {
        const name = fnName(node)
        const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        if (name) {
          if (!isAsync) syncNames.add(name)
          else {
            const guarded = !!node.body && ts.isBlock(node.body)
              && node.body.statements.some((s) => ts.isTryStatement(s) && !!s.catchClause)
            const prior = asyncInfo.get(name)
            asyncInfo.set(name, { guarded: guarded || !!prior?.guarded })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  /** Can this call site's target be resolved? A bare `name(…)` resolves by
   *  name; a method call only when it is `this.name(…)` (the object's own
   *  method) or one of the calls that is async by contract (`fetch`), because
   *  the receiver of `map.delete(…)` is not knowable here. */
  const resolvable = (call) => {
    const callee = call.expression
    if (ts.isIdentifier(callee)) return true
    if (ts.isPropertyAccessExpression(callee)) {
      return callee.expression.kind === ts.SyntaxKind.ThisKeyword
        || ASYNC_BY_CONTRACT.has(callee.name.text)
    }
    return false
  }

  /** Is this call already carried by a `try` in the function that contains it?
   *  Walking UP stops at the function boundary: a try in the CALLER's caller
   *  cannot catch a rejection that happens here, and pretending it can is how a
   *  check like this turns into an excuse machine. */
  const carriedByTry = (node) => {
    let n = node
    while (n && n.parent) {
      const p = n.parent
      if (ts.isTryStatement(p) && p.tryBlock === n) return true
      if (ts.isFunctionLike(p)) return false
      n = p
    }
    return false
  }

  const usedExceptions = new Set()
  const exceptionFor = (code, file, name) => {
    for (let i = 0; i < policy.length; i++) {
      const p = policy[i]
      if (p.code !== code) continue
      if (p.file && p.file !== file) continue
      if (p.callee && p.callee !== name) continue
      usedExceptions.add(i)
      return p
    }
    return null
  }

  const inventories = new Map()
  const add = (path, line, code, detail) => {
    faults.push({ code, file: rel(path), line, detail })
  }

  const covered = []
  for (const { path, chunk, sf } of parsed) {
    const file = rel(path)
    const net = rejectionNet(sf)
    let fnCount = 0
    const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + chunk.startLine
    // The function the walker is inside of, so a finding can name the caller a
    // reader has to open ("inside softRefresh()"), and so the WALKER can tell an
    // entry point from a dropped call: `await` is only available inside a
    // function, so that is exactly where dropping a promise is a decision.
    const inside = []
    // `boot()` at the bottom of a page is the app starting, not a dropped
    // promise: nothing can await it and a page has no caller to reject to. The
    // check therefore lives INSIDE functions, which is where a caller exists
    // that could have awaited — everything else is a declared exception.
    const isEntryPoint = () => inside.length === 0

    const visit = (node) => {
      const named = FN_KINDS.has(node.kind)
      if (named) { fnCount++; inside.push(fnName(node) || '(anonymous)') }

      // ── floating-async ──
      if (ts.isExpressionStatement(node) && !isEntryPoint()) {
        let expr = node.expression
        let intentional = false
        // `void doThing()` is how a bare call says "I meant to drop this".
        if (ts.isVoidExpression(expr)) intentional = true
        // `doThing().catch(…)` / `.then(…)` / `.finally(…)` carries it.
        if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
          && ['catch', 'then', 'finally'].includes(expr.expression.name.text)) intentional = true
        if (!intentional && ts.isCallExpression(expr)) {
          const name = calleeName(expr)
          const ambiguous = !!name && syncNames.has(name) && !ASYNC_BY_CONTRACT.has(name)
          if (name && resolvable(expr) && asyncInfo.has(name) && !asyncInfo.get(name).guarded
            && !ambiguous && !carriedByTry(node)) {
            const excuse = exceptionFor('floating-async', file, name)
            if (!excuse) {
              const detail = `inside ${inside[inside.length - 1]}(): ${name}(…) is called as a statement, so its rejection is unhandled and the code below runs as if it had finished — \`await\` it, \`void\` it, or declare the exception`
              if (net) covered.push({ code: 'covered-by-net', file, line: at(node), detail })
              else add(path, at(node), 'floating-async', detail)
            }
          }
        }
      }

      // ── empty-catch ──
      // The body must have NO statements. A comment inside it is the declaration
      // that the silence is deliberate (this app has a few by contract: a gate
      // counter that must never throw, a phone's best-effort localStorage write),
      // so the flag is "empty AND unexplained", which is the thing a reader
      // cannot tell from a bug.
      if (ts.isCatchClause(node) && node.block.statements.length === 0 && !isEntryPoint()) {
        const inner = node.block.getText(sf).slice(1, -1)
        // The try block lives on the TryStatement, not on the catch — asking the
        // catch clause for `tryBlock` reads `undefined`, and `undefined` is a try
        // block with nothing risky in it, so the check would pass every silent
        // catch in the tree while looking like it ran.
        const tryStmt = node.parent
        const tried = ts.isTryStatement(tryStmt) ? tryStmt.tryBlock : null
        if (!/\/[/*]/.test(inner) && (tried ? tryBlockCanFailMeaningfully(tried) : true)) {
          add(path, at(node), 'empty-catch',
            `inside ${inside[inside.length - 1]}(): a catch with an empty body and no comment around work that can genuinely fail — handle it, rethrow it, or leave a comment saying why silence is right`)
        }
      }

      // ── async-callback ──
      // `forEach` never returns anything its callback could be collected into,
      // so an awaiting callback there is a fault however the call is used.
      // `map`/`filter`/`some`/`every`/`find` DO return the promises, and the
      // correct form is `await Promise.all(x.map(async …))` — so those are a
      // fault only when the result is DROPPED (a bare statement), which is the
      // form whose rejections nobody can ever see.
      if (ts.isCallExpression(node)) {
        const name = calleeName(node)
        const dropped = ts.isExpressionStatement(node.parent)
          || (ts.isVoidExpression(node.parent) && node.parent.expression === node)
        if (name && SYNC_CALLBACKS.has(name) && (name === 'forEach' || dropped)) {
          for (const arg of node.arguments) {
            if (!ts.isFunctionLike(arg)) continue
            const isAsync = arg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
            const hasAwait = containsOwnAwait(arg)
            if (isAsync || hasAwait) {
              const fn = fnName(arg) || name
              if (!exceptionFor('async-callback', file, fn)) {
                add(path, at(node), 'async-callback',
                  `${name}(…) is given a callback that awaits: ${name} does not wait for it, so a rejection inside is unhandled${['filter', 'some', 'every'].includes(name) ? ' and the Promise it returns counts as true' : ''} — collect the promises and await them (or use Promise.all)`)
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit)
      if (named) inside.pop()
    }
    visit(sf)
    inventories.set(file, (inventories.get(file) ?? 0) + fnCount)
  }

  // ── exceptions that no longer excuse anything ──
  policy.forEach((p, i) => {
    if (usedExceptions.has(i)) return
    faults.push({
      code: 'stale-exception', file: p.file ?? '(any)', line: 0,
      detail: `FUNCTION_POLICY declares an exception for ${p.code}${p.callee ? ` on ${p.callee}(…)` : ''}${p.file ? ` in ${p.file}` : ''} and nothing matches it — delete the entry or point it at the code it still describes`,
    })
  })

  return { functions: inventories, faults, covered }
}

/** A function's own name, whichever way it was written. */
function fnName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.text ?? null
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null
  }
  if (ts.isArrowFunction(node)) {
    const p = node.parent
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text
    if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (p && ts.isBinaryExpression(p) && ts.isIdentifier(p.left)) return p.left.text
  }
  return null
}

function existsFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/** The report, one line per finding, grouped by file so a reader can work
 *  through it the way the tree is laid out. */
export function formatFaults(faults) {
  const byFile = new Map()
  for (const f of faults) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }
  const out = []
  for (const [file, list] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${file}`)
    for (const f of list.sort((a, b) => a.line - b.line)) {
      out.push(`  ${f.line ? `${f.line}: ` : ''}[${f.code}] ${f.detail}`)
    }
  }
  return out
}
