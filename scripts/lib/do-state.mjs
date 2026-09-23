// ─── Durable Object instance-state analyzer ─────────────────────
// Finds REQUEST DATA PARKED ON `this` — the same bug family as
// `module-state.mjs`, one level down.
//
// Why this is not the same check. A module-scope binding is shared by every
// request in an isolate, so a WRITE to it is always wrong. `this` inside a
// Durable Object is different in a way that makes the rule harder and the stakes
// lower: the object belongs to ONE entity (here, one household's fleet), so
// state on `this` is legitimate — a geofence cache, a cooldown map and a
// rate-limit ledger all belong there and would be pointless anywhere else.
//
// What is NOT legitimate is a single-slot field that a request ASSIGNS and then
// reads after an `await`. A DO is single-threaded, which is exactly the trap: it
// guarantees no two instructions overlap, and says nothing about two REQUESTS.
// They interleave at every await, so
//
//     this.currentDevice = body.deviceId     // request A
//     ... await ...                          // request B runs: same assignment
//     use(this.currentDevice)                // A now acts on B's device
//
// is a cross-request leak wearing the costume of ordinary object state. So the
// rule is narrower than "no state on `this`": it is about a field written from a
// request and read across an interleaving point.
//
// The findings, in the order they cost a reader:
//   1. `undeclared`       — an instance field nobody has declared here. This is
//                           the load-bearing one: the registry below is where a
//                           field states WHY it is object state and not request
//                           data, so a new field cannot arrive unexamined.
//   2. `wrong-write`      — a field written in a way its declared kind forbids
//                           (a cache fed from request data, a handle written
//                           outside the constructor).
//   3. `read-after-await` — a field assigned from request data and read after an
//                           await in the same method: the interleaving window.
//   4. `cross-request`    — a field assigned from request data in one method and
//                           read in another: the value outlived its request.
//   5. `undeclared-reader`— a `diagnostics` field read somewhere its registry
//                           entry did not name.
//
// Scope comes from `wrangler.jsonc`, not from `extends DurableObject`: a DO
// registered with `class_name` is a DO whether or not the class in the code
// extends anything (Laoka's `Lobby` is a plain class), and the bindings are the
// list Cloudflare actually instantiates. A class named there and missing from
// the source is itself a fault.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, extname, relative, isAbsolute } from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// The compiler, resolved from the REPO's node_modules and bound once at module
// load. A handle to a library is not request state: it is immutable, identical
// for every caller, and nothing writes to it.
const require = createRequire(join(REPO_ROOT, 'package.json'))
const ts = require('typescript')
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist'])
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']

/** Human words for each write kind, for the failure message. */
const WRITE_KIND = {
  constructor: 'the constructor',
  db: 'a database read',
  invalidate: 'an invalidation (null)',
  mutator: 'a keyed mutator call',
  request: 'request data',
  other: 'something else',
}

/**
 * Every instance field of every Durable Object, with the reason it is object
 * state. `kind` is the CLAIM; the analyzer checks the writes against it, so an
 * entry that stops being true turns the suite red instead of quietly excusing
 * itself.
 *
 *   handle      — a handle to the object's own machinery, set once in the
 *                 constructor and never reassigned.
 *   db-cache    — a cache of database rows. Request-independent BY
 *                 CONSTRUCTION: two requests racing to refill it compute the
 *                 same value, so a lost update costs one query and changes
 *                 nothing anybody can observe.
 *   keyed       — state addressed by a key (device, person, event). Two requests
 *                 writing different keys cannot collide, which is the whole
 *                 reason these are Maps rather than single slots.
 *   diagnostics — a report of the LAST thing that happened, written from request
 *                 data on purpose and read only by the surfaces named in
 *                 `readOnlyIn`. It decides nothing; the reader list is what pins
 *                 that, and it is why this kind is the one place a
 *                 request-derived write is allowed at all.
 */
export const DO_STATE_POLICY = {
  'FleetDO.sql': {
    kind: 'handle',
    why: "the object's SQLite handle, captured once in the constructor",
  },
  'FleetDO.geofenceCache': {
    kind: 'db-cache',
    why: 'way-db geofences; refilled from the table and invalidated to null by /reload-geofences',
  },
  'FleetDO.notifyCache': {
    kind: 'db-cache',
    why: 'topics + the subscription grid + the resolved server; refilled from way-db/home-db, invalidated to null by /reload-notifications',
  },
  'FleetDO.notifyCooldowns': {
    kind: 'keyed',
    why: 'per person:event:fence cooldown stamps — the key is what makes it safe',
  },
  'FleetDO.notifyDaily': {
    kind: 'keyed',
    why: 'per person id, a day and a count for the daily push cap',
  },
  'FleetDO.approachFired': {
    kind: 'keyed',
    why: 'per device:fence, which approach thresholds were already announced',
  },
  'FleetDO.approachPulses': {
    kind: 'keyed',
    why: "per device, the map badge's in-flight pulse — deliberately never persisted",
  },
  'FleetDO.lastNotify': {
    kind: 'diagnostics',
    readOnlyIn: ['fetch'],
    why: "the last notification routing decision, read only by /debug-notify's payload so a routing failure is readable without a live tail. It decides nothing — no branch anywhere consults it. That last sentence is what the reader list enforces: a new reader means it is no longer diagnostics",
  },
  'Lobby.ctx': {
    kind: 'handle',
    why: 'the DO context (acceptWebSocket + getWebSockets for hibernation)',
  },
  'Lobby.env': {
    kind: 'handle',
    why: 'the bindings, set once in the constructor',
  },
}

/** Which write kinds each declared kind permits; anything else is `wrong-write`. */
const ALLOWED_WRITES = {
  handle: ['constructor'],
  'db-cache': ['db', 'invalidate'],
  keyed: ['mutator', 'invalidate'],
  diagnostics: ['request', 'db', 'invalidate', 'other', 'mutator'],
}

const MUTATORS = new Set([
  'set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift',
  'splice', 'sort', 'reverse', 'fill', 'copyWithin',
])

/** Every name a binding pattern introduces: `{ results }`, `[a, b]`, `{ x: y }`. */
function bindingNames(name) {
  if (!name) return []
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((el) => ts.isBindingElement(el) ? bindingNames(el.name) : [])
  }
  return []
}

const FUNCTION_KIND_NAMES = [
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction',
  'MethodDeclaration', 'Constructor', 'GetAccessor', 'SetAccessor',
]

/**
 * Strip `//` and block comments so wrangler.jsonc parses as JSON.
 *
 * It has to be a real scanner rather than a regex, because the file contains
 * `"https://…"` — and `//` inside a string is a URL, not a comment. A regex eats
 * the rest of that line, and the failure is not "unparseable": the value silently
 * comes back truncated, which is the kind of quiet wrong answer this whole
 * folder exists to avoid. Trailing commas are tolerated afterwards.
 */
export function stripJsonc(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) { if (c === '\n') { inLine = false; out += c } continue }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++ } continue }
    if (inString) {
      out += c
      if (c === '\\') { out += next ?? ''; i++ }
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLine = true; i++; continue }
    if (c === '/' && next === '*') { inBlock = true; i++; continue }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** The DO class names Cloudflare actually instantiates, from the bindings. */
export function durableObjectClasses(wranglerPath) {
  const raw = readFileSync(wranglerPath, 'utf8')
  let config
  try {
    config = JSON.parse(stripJsonc(raw))
  } catch (e) {
    // Loud on purpose: a config this cannot read must never read as "no
    // Durable Objects to check" — a clean report for the wrong reason, which is
    // the failure mode section 25's own controls exist to catch.
    throw new Error(`could not parse ${wranglerPath}: ${e.message}`)
  }
  const bindings = config?.durable_objects?.bindings ?? []
  return bindings.map((b) => b.class_name).filter(Boolean)
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
 * Analyze the Durable Objects named in `wrangler.jsonc`.
 *
 * Returns { classes, faults }. `classes` is the inventory (each field with its
 * kind and declared reason) so a caller can print what IS there, not only what
 * is wrong; `faults` are the findings, each carrying a `code`.
 */
export function scanDoState({
  wrangler = 'wrangler.jsonc',
  root = 'src',
  // The three below exist for the CONTROLS that keep this honest (smoke §25):
  // a checker that is only ever pointed at a clean tree cannot show that it
  // would notice a fault, and the controls need a class and a policy of their
  // own. Nothing in the shipped path passes them.
  extraSources = [],
  wranglerClasses,
  policy,
} = {}) {
  const FUNCTION_KINDS = new Set(FUNCTION_KIND_NAMES.map((n) => ts.SyntaxKind[n]))
  const policyTable = policy ? { ...DO_STATE_POLICY, ...policy } : DO_STATE_POLICY

  const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/')
  const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const wranglerPath = isAbsolute(wrangler) ? wrangler : join(REPO_ROOT, wrangler)
  // A config this cannot read is a FINDING, not an exception. Throwing out of
  // here would take the whole suite down with a stack trace instead of naming a
  // red check, and catching it silently would be worse: "no Durable Objects" is
  // a clean report for the wrong reason, which is the failure this tool exists
  // to make impossible. So it becomes a fault of its own.
  const faults = []
  let wanted = wranglerClasses
  if (!wanted) {
    try {
      wanted = durableObjectClasses(wranglerPath)
    } catch (e) {
      wanted = []
      faults.push({
        code: 'config-unreadable', field: rel(wranglerPath), file: rel(wranglerPath), line: 0,
        detail: `${rel(wranglerPath)} could not be read (${e.message}) — the Durable Object list is unknown, so nothing below was checked`,
      })
    }
  }

  const base = isAbsolute(root) ? root : join(REPO_ROOT, root)
  const sources = collectFiles(base).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  for (const s of extraSources) sources.push(s)

  const parsed = sources.map(({ path, text }) => {
    const kind = extname(path) === '.tsx' ? ts.ScriptKind.TSX
      : extname(path) === '.ts' ? ts.ScriptKind.TS
        : ts.ScriptKind.JS
    return { path, sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind) }
  })

  const classes = []
  for (const name of wanted) {
    let found = null
    for (const { path, sf } of parsed) {
      const hit = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === name)
      if (hit) { found = { path, sf, node: hit }; break }
    }
    if (!found) {
      faults.push({
        code: 'missing-class', field: name, file: rel(wranglerPath), line: 0,
        detail: `wrangler.jsonc registers ${name} as a Durable Object but no class of that name exists under ${root}/`,
      })
      continue
    }

    const { path, sf, node: cls } = found
    const file = rel(path)
    const classLine = lineOf(sf, cls)

    // ── the fields this class has ──
    // DECLARED fields (TypeScript's `private notifyCache: … | null = null`) and
    // ASSIGNED ones (`this.ctx = ctx` in a plain-JS constructor) both count.
    // Taking only the declarations would leave every JavaScript Durable Object
    // unanalyzable — Laoka's `Lobby` is exactly that — and would report it as a
    // class with no fields, which reads as "nothing to worry about here".
    const fieldNames = new Set()
    for (const member of cls.members) {
      if (ts.isPropertyDeclaration(member)
        && !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
        && ts.isIdentifier(member.name)) {
        fieldNames.add(member.name.text)
      }
    }
    const isThisAccess = (n) => ts.isPropertyAccessExpression(n)
      && n.expression.kind === ts.SyntaxKind.ThisKeyword
      && ts.isIdentifier(n.name)

    /** How a `this.field` node is written, from its own position in the tree. */
    const writeKindOf = (node) => {
      const parent = node.parent
      // `this.f = …`
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (parent.left === node) return { how: 'assign', rhs: parent.right }
      }
      // `this.f[key] = …` — writing THROUGH the field, which is keyed by definition
      if (ts.isElementAccessExpression(parent)
        && ts.isBinaryExpression(parent.parent)
        && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && parent.parent.left === parent) {
        return { how: 'mutator', rhs: null }
      }
      // `this.f.set(…)` / `.delete(…)` — a keyed mutator call
      if (ts.isPropertyAccessExpression(parent) && ts.isIdentifier(parent.name)
        && MUTATORS.has(parent.name.text)
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        return { how: 'mutator', rhs: null }
      }
      return null
    }

    // ── every name this class assigns to `this` ──
    // This runs BEFORE the undeclared check below and before any method is
    // classified, and the order is the whole point: the check is only as
    // complete as `fieldNames` is when it runs. A field that exists only by
    // assignment (`this.ctx = ctx` in a plain-JS class) is invisible to the
    // declarations above, so collecting it any later -- which this did, after
    // the method walk -- lists the field as `(undeclared)` in the inventory
    // while pushing NO fault: the audit exits 0 and prints "every field is
    // declared" about a class it has just called undeclared. That is finding 1
    // of 5, the load-bearing one, dropped in BOTH readers at once -- the CLI and
    // smoke §25 both take this fault list, so the suite agreed with the wrong
    // answer and no control noticed. (The driver could not have caught it
    // either: its undeclared mutation M2 adds a TypeScript DECLARATION, which
    // the seed above does see.) Collecting the names here also completes the set
    // `isThisField` classifies against, so an access that precedes the first
    // write in source order is still recognised as a field.
    {
      const loose = (n) => {
        if (isThisAccess(n) && writeKindOf(n)) fieldNames.add(n.name.text)
        ts.forEachChild(n, loose)
      }
      for (const member of cls.members) loose(member)
    }

    for (const field of fieldNames) {
      if (!policyTable[`${name}.${field}`]) {
        faults.push({
          code: 'undeclared', field, file, line: classLine,
          detail: `${name}.${field} is instance state nobody declared: add it to DO_STATE_POLICY in scripts/lib/do-state.mjs with its kind and the reason it is object state rather than request data`,
        })
      }
    }

    /** The events of ONE method, in source order. */
    const eventsOf = (member, methodName) => {
      const events = []
      const isCtor = ts.isConstructorDeclaration(member)
      let seq = 0
      // One level of dataflow: a local assigned from a parameter — or from an
      // await that touches one — is request data too, so
      // `const body = await request.json(); this.x = body` is still caught.
      // One level, not a fixed point: a chain of locals is beyond a checker this
      // size, and the registry is what catches a field that slips through.
      const tainted = new Map()

      const paramsOf = (m) => (m.parameters ?? [])
        .map((p) => p.name).filter(ts.isIdentifier).map((p) => p.text)

      const classify = (expr, paramStack) => {
        const names = new Set()
        // Collect the identifiers this expression READS. A property NAME
        // (`results.map` -> `map`) and anything DECLARED inside the expression
        // (an arrow's parameters: `results.map((r) => r.lat)`) are not reads, and
        // counting them would classify an honest mapping as request data the
        // moment a callback parameter happened to share a name with one of the
        // method's own parameters.
        const scanNames = (n) => {
          if (ts.isIdentifier(n)) {
            const p = n.parent
            const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === n
            const isDeclaration = (ts.isVariableDeclaration(p) || ts.isParameter(p)
              || ts.isBindingElement(p)) && p.name === n
            const isObjectKey = ts.isPropertyAssignment(p) && p.name === n
            if (!isPropertyName && !isDeclaration && !isObjectKey) names.add(n.text)
          }
          ts.forEachChild(n, scanNames)
        }
        scanNames(expr)
        // `paramStack` is a stack of parameter-name LISTS (one per enclosing
        // function, so a nested arrow sees its own parameters and its caller's).
        // Comparing names against the stack itself rather than its flattened
        // contents matches nothing, and every request value then classifies as
        // "something else" — which silently disarms every check below.
        const params = paramStack.flat()
        for (const n of names) if (params.includes(n)) return 'request'
        for (const n of names) if (tainted.get(n) === 'request') return 'request'
        let hasAwait = false
        const findAwait = (n) => { if (ts.isAwaitExpression(n)) hasAwait = true; ts.forEachChild(n, findAwait) }
        findAwait(expr)
        if (hasAwait) return 'db'
        for (const n of names) if (tainted.get(n) === 'db') return 'db'
        if (/this\.env\.|\.prepare\(/.test(expr.getText(sf))) return 'db'
        if (expr.kind === ts.SyntaxKind.NullKeyword) return 'invalidate'
        return 'other'
      }

      const walk = (n, paramStack) => {
        const pushed = FUNCTION_KINDS.has(n.kind)
        if (pushed) paramStack.push(paramsOf(n))

        if (isThisField(n)) {
          const write = writeKindOf(n)
          if (write) {
            const writeKind = write.how === 'mutator' ? 'mutator'
              : isCtor ? 'constructor'
                : classify(write.rhs, paramStack)
            events.push({ seq: seq++, kind: 'write', field: n.name.text, writeKind, node: n })
          } else {
            events.push({ seq: seq++, kind: 'read', field: n.name.text, node: n })
          }
        }

        if (ts.isAwaitExpression(n)) events.push({ seq: seq++, kind: 'await', node: n })

        // Provenance of a local, recorded before its use sites are walked.
        // Destructuring counts: `const { results } = await …` taints `results`,
        // and without that the geofence cache refill reads as "something else".
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const c = classify(n.initializer, paramStack)
          if (c === 'request' || c === 'db') {
            for (const name of bindingNames(n.name)) tainted.set(name, c)
          }
        }

        ts.forEachChild(n, (child) => walk(child, paramStack))
        if (pushed) paramStack.pop()
      }

      // The method's OWN parameters seed the stack: the walk starts inside the
      // body, so the node that would push them is never visited. Without this
      // every parameter reads as an unknown local and request data classifies as
      // "something else" — which quietly disarms the whole check.
      if (member.body) walk(member.body, [paramsOf(member)])
      return { method: methodName, events }
    }

    // `fieldNames` is complete by now -- declarations plus every assignment, all
    // collected above -- so the strict predicate the walk classifies against is
    // the same set the undeclared check tested.
    const isThisField = (n) => isThisAccess(n) && fieldNames.has(n.name.text)

    // ── walk every method of the class ──
    const methods = []
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)
        && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue
      const methodName = ts.isConstructorDeclaration(member) ? 'constructor'
        : ts.isIdentifier(member.name) ? member.name.text : '(computed)'
      methods.push(eventsOf(member, methodName))
    }

    // ── 3. read-after-await: the interleaving window, within one method ──
    for (const { method, events } of methods) {
      const awaits = events.filter((e) => e.kind === 'await').map((e) => e.seq)
      if (!awaits.length) continue
      const firstAwait = Math.min(...awaits)
      for (const w of events.filter((e) => e.kind === 'write' && e.writeKind === 'request')) {
        const after = events.find((e) => e.kind === 'read' && e.field === w.field
          && e.seq > w.seq && e.seq > firstAwait)
        if (after) {
          faults.push({
            code: 'read-after-await', field: w.field, file, line: lineOf(sf, w.node), method,
            detail: `${name}.${w.field} is assigned from request data at line ${lineOf(sf, w.node)} in ${method}() and read again at line ${lineOf(sf, after.node)} past an await — another request can overwrite it inside that window`,
          })
        }
      }
    }

    // ── 4. cross-request: request data written here, read there ──
    const writesByField = new Map()
    const readsByField = new Map()
    for (const { method, events } of methods) {
      for (const e of events) {
        if (e.kind === 'write' && e.writeKind === 'request') {
          if (!writesByField.has(e.field)) writesByField.set(e.field, new Set())
          writesByField.get(e.field).add(method)
        } else if (e.kind === 'read') {
          if (!readsByField.has(e.field)) readsByField.set(e.field, new Set())
          readsByField.get(e.field).add(method)
        }
      }
    }
    for (const [field, writers] of writesByField) {
      const readers = readsByField.get(field) ?? new Set()
      const entry = policyTable[`${name}.${field}`]

      if (entry?.kind === 'diagnostics') {
        // 5. the pin that makes "it decides nothing" checkable: a NEW reader is a
        // red check, because that is the only way this field starts mattering.
        const allowed = new Set(entry.readOnlyIn ?? [])
        const stray = [...readers].filter((m) => !allowed.has(m))
        if (stray.length) {
          faults.push({
            code: 'undeclared-reader', field, file, line: classLine,
            detail: `${name}.${field} is declared diagnostics but is read from ${stray.join(', ')} — either it now decides something (then pass it as a parameter like any other request data) or name the reader in DO_STATE_POLICY`,
          })
        }
        continue
      }

      for (const reader of readers) {
        for (const writer of writers) {
          if (reader !== writer) {
            faults.push({
              code: 'cross-request', field, file, line: classLine,
              detail: `${name}.${field} is written from request data in ${writer}() and read in ${reader}(): the value outlives the request that set it`,
            })
          }
        }
      }
    }

    // ── 2. registry conformance: does each declared kind hold? ──
    for (const { method, events } of methods) {
      for (const e of events) {
        if (e.kind !== 'write') continue
        const entry = policyTable[`${name}.${e.field}`]
        if (!entry) continue                       // already reported as undeclared
        const allowed = ALLOWED_WRITES[entry.kind] ?? []
        if (!allowed.includes(e.writeKind)) {
          faults.push({
            code: 'wrong-write', field: e.field, file, line: lineOf(sf, e.node), method,
            detail: `${name}.${e.field} is declared ${entry.kind} but written from ${WRITE_KIND[e.writeKind]} in ${method}() — allowed: ${allowed.map((a) => WRITE_KIND[a]).join(', ')}`,
          })
        }
      }
    }

    classes.push({
      name, file,
      fields: [...fieldNames].map((f) => ({
        field: f,
        kind: policyTable[`${name}.${f}`]?.kind ?? '(undeclared)',
        why: policyTable[`${name}.${f}`]?.why ?? '',
      })),
    })
  }

  return { classes, faults }
}

/** One line per fault, so a failure message is readable in a terminal. */
export function formatDoFaults(faults) {
  return faults.map((f) => `[${f.code}] ${f.file}${f.line ? ':' + f.line : ''} ${f.detail}`)
}
