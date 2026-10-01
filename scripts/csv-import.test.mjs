/**
 * Laoka CSV hand-off parser — `node --test`.
 *
 * The importer lives in browser JS inside a server-side template literal in
 * `src/routes/budget.tsx`, so there is no module to import. Rather than copy the
 * code (which would let the tests drift from what actually ships), these tests
 * extract the function source from the page and evaluate *that*, so they always
 * exercise the real shipped copy — the one production serves.
 *
 * The extractor understands exactly one template-literal escaping convention:
 * every backslash in the source is doubled (`\\` → `\`) and a backtick is
 * escaped (`\``), which is how the block is written today. It fails loudly if
 * another escape is introduced, so the tests can never silently test the wrong
 * text.
 *
 * No dev server, no database, no mocks — unlike `npm run smoke`.
 * Run: `npm test`. `npm run verify` = check + test + smoke.
 *
 * Mirror of `../Sompitra/tests/csv-import.test.mjs`; keep the two in step.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BUDGET_PAGE = path.join(here, '..', 'src', 'routes', 'budget.tsx')

const SCRIPT_MARKER = 'dangerouslySetInnerHTML={{ __html: `'

/** Read a template-literal body starting at `from`, stopping at the closing backtick. */
function readTemplateBody(source, from) {
  let i = from
  let raw = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      raw += ch + source[i + 1]
      i += 2
      continue
    }
    if (ch === '`') return raw
    raw += ch
    i += 1
  }
  throw new Error('unterminated template literal in budget.tsx')
}

/** The body of the first inline `<script>` block that contains `needle`. */
function scriptContaining(source, needle) {
  for (let p = source.indexOf(SCRIPT_MARKER); p !== -1; p = source.indexOf(SCRIPT_MARKER, p + 1)) {
    const body = readTemplateBody(source, p + SCRIPT_MARKER.length)
    if (body.includes(needle)) return body
  }
  throw new Error(`no inline <script> block in budget.tsx contains ${needle}`)
}

/** Inverse of the escaping the template literal applies to its body. */
function unescapeTemplate(raw) {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') continue
    const next = raw[i + 1]
    if (next !== '\\' && next !== '`') {
      throw new Error(
        `unsupported escape sequence \\${next} in budget.tsx script — ` +
          'update unescapeTemplate() in scripts/csv-import.test.mjs',
      )
    }
    i += 1
  }
  return raw.replace(/\\`/g, '`').replace(/\\\\/g, '\\')
}

/** Evaluate the three CSV functions exactly as the browser receives them. */
function loadCsvFunctions() {
  const source = fs.readFileSync(BUDGET_PAGE, 'utf8')
  const body = unescapeTemplate(scriptContaining(source, 'function parseCsvRows'))

  const from = body.indexOf('function csvTitleFromFilename(')
  const to = body.indexOf('function readFileText(')
  assert.ok(from !== -1 && to > from, 'the CSV functions were not found in the budget page script')

  const code = body.slice(from, to)
  // Client JS inside a server-side template literal must never contain `${…}`
  // (the server would evaluate it first).
  assert.ok(!code.includes('${'), 'the shipped CSV client code must not contain ${ interpolation')

  return new Function(`${code}\nreturn { csvTitleFromFilename, splitCsvLine, parseCsvRows }`)()
}

const { csvTitleFromFilename, splitCsvLine, parseCsvRows } = loadCsvFunctions()

test('the shipped CSV functions are extracted as real functions', () => {
  assert.equal(typeof csvTitleFromFilename, 'function')
  assert.equal(typeof splitCsvLine, 'function')
  assert.equal(typeof parseCsvRows, 'function')
  assert.equal(parseCsvRows.length, 1)
})

// ─── splitCsvLine ────────────────────────────────────────────
test('splitCsvLine() splits on the delimiter and honours quotes', () => {
  assert.deepEqual(splitCsvLine('Rice,2000', ','), ['Rice', '2000'])
  assert.deepEqual(splitCsvLine('Rice;2000', ';'), ['Rice', '2000'])
  assert.deepEqual(splitCsvLine('Rice,', ','), ['Rice', ''])
  assert.deepEqual(splitCsvLine(',2000', ','), ['', '2000'])
})

test('splitCsvLine() keeps a quoted delimiter inside one cell', () => {
  assert.deepEqual(splitCsvLine('"Pork, lean",4500', ','), ['Pork, lean', '4500'])
  assert.deepEqual(splitCsvLine('"Pork; lean";4500', ';'), ['Pork; lean', '4500'])
})

test('splitCsvLine() unescapes doubled quotes', () => {
  assert.deepEqual(splitCsvLine('"Say ""hi""",100', ','), ['Say "hi"', '100'])
})

test('splitCsvLine() swallows the rest of the line after an unclosed quote', () => {
  // The parser is deliberately tolerant: any quote outside a quoted run opens
  // one, so an unclosed quote folds the remainder of the line into one cell.
  assert.deepEqual(splitCsvLine('4" nail,200', ','), ['4 nail,200'])
  assert.deepEqual(splitCsvLine('Rice,2000', ','), ['Rice', '2000'])
})

test('parseCsvRows() skips a row whose quote never closes', () => {
  // Degrades to a reported skip instead of a crash or a bogus import.
  assert.deepEqual(parseCsvRows('Item,Price\n4" nail,200\n'), { rows: [], skipped: [2] })
})

// ─── parseCsvRows: shape ─────────────────────────────────────
test('parseCsvRows() always returns { rows, skipped }', () => {
  for (const input of ['', null, undefined, 'Item,Price\n']) {
    const parsed = parseCsvRows(input)
    assert.deepEqual(parsed, { rows: [], skipped: [] }, `input: ${JSON.stringify(input)}`)
  }
})

test('parseCsvRows() returns { name, price } numbers, not strings', () => {
  const { rows } = parseCsvRows('Item,Price\nRice,2000\n')
  assert.deepEqual(rows, [{ name: 'Rice', price: 2000 }])
  assert.equal(typeof rows[0].price, 'number')
})

// ─── parseCsvRows: happy paths ───────────────────────────────
test('parseCsvRows() reads a comma file and drops the header row silently', () => {
  const text = 'Item,Price\nRice,2000\nBeans,1500\n'
  assert.deepEqual(parseCsvRows(text), {
    rows: [
      { name: 'Rice', price: 2000 },
      { name: 'Beans', price: 1500 },
    ],
    skipped: [],
  })
})

test('parseCsvRows() detects the semicolon delimiter from the first row', () => {
  assert.deepEqual(parseCsvRows('Item;Price\nRice;2000\nBeans;1500\n').rows, [
    { name: 'Rice', price: 2000 },
    { name: 'Beans', price: 1500 },
  ])
})

test('parseCsvRows() uses a comma when the first row has both separators', () => {
  // "Item;Name,Price" — a comma is present, so comma wins and the semicolon is literal.
  const { rows } = parseCsvRows('Item;Name,Price\nPork;loin,3000\n')
  assert.deepEqual(rows, [{ name: 'Pork;loin', price: 3000 }])
})

test('parseCsvRows() strips a UTF-8 BOM so the header is still recognised', () => {
  assert.deepEqual(parseCsvRows('\uFEFFItem;Price\nRice;2000\n'), {
    rows: [{ name: 'Rice', price: 2000 }],
    skipped: [],
  })
})

test('parseCsvRows() handles CRLF line endings', () => {
  assert.deepEqual(parseCsvRows('Item,Price\r\nRice,2000\r\nBeans,1500\r\n'), {
    rows: [
      { name: 'Rice', price: 2000 },
      { name: 'Beans', price: 1500 },
    ],
    skipped: [],
  })
})

test('parseCsvRows() skips blank lines without reporting them', () => {
  assert.deepEqual(parseCsvRows('Item,Price\n\nRice,2000\n   \nBeans,1500\n'), {
    rows: [
      { name: 'Rice', price: 2000 },
      { name: 'Beans', price: 1500 },
    ],
    skipped: [],
  })
})

test('parseCsvRows() imports a file that has no header row', () => {
  assert.deepEqual(parseCsvRows('Rice,2000\nBeans,1500\n'), {
    rows: [
      { name: 'Rice', price: 2000 },
      { name: 'Beans', price: 1500 },
    ],
    skipped: [],
  })
})

test('parseCsvRows() unescapes quoted names and keeps the delimiter inside them', () => {
  const { rows } = parseCsvRows('Item,Price\n"Pork, lean",4500\n"Say ""hi""",100\n')
  assert.deepEqual(rows, [
    { name: 'Pork, lean', price: 4500 },
    { name: 'Say "hi"', price: 100 },
  ])
})

test('parseCsvRows() trims surrounding whitespace in the name', () => {
  assert.deepEqual(parseCsvRows('Item,Price\n  Rice  ,2000\n').rows, [{ name: 'Rice', price: 2000 }])
})

// ─── parseCsvRows: prices ────────────────────────────────────
test('parseCsvRows() keeps digits only, so currency text and separators read the same', () => {
  const text = [
    'Item,Price',
    'pork,"Ar 3 000"',
    'rice,"3,000"',
    'beans,3.000',
    'salt,Ar 12 500 MGA',
    'oil,1 200',
  ].join('\n')
  assert.deepEqual(parseCsvRows(text).rows, [
    { name: 'pork', price: 3000 },
    { name: 'rice', price: 3000 },
    { name: 'beans', price: 3000 },
    { name: 'salt', price: 12500 },
    { name: 'oil', price: 1200 },
  ])
})

// ─── parseCsvRows: skipped rows ──────────────────────────────
test('parseCsvRows() skips rows with no name, no price or a zero price', () => {
  const text = 'Item,Price\n,2000\nRice,0\nBeans,\nSalt,abc\n'
  assert.deepEqual(parseCsvRows(text), { rows: [], skipped: [2, 3, 4, 5] })
})

test('parseCsvRows() reports a split thousands separator instead of importing a wrong price', () => {
  // "pork,4,500" is a 4,500 purchase whose separator got split into a third
  // column; recording Ar 4 would be worse than skipping the line.
  assert.deepEqual(parseCsvRows('Item,Price\npork,4,500\n'), { rows: [], skipped: [2] })
  assert.deepEqual(parseCsvRows('pork,4,500\nrice,2000,500\n'), {
    rows: [{ name: 'rice', price: 2000 }],
    skipped: [1],
  })
})

test('parseCsvRows() keeps column 2 when the extra columns are not a split separator', () => {
  // A plausible price followed by anything is kept; only a 1–3 digit column 2
  // followed by a 3-digit column is treated as a broken thousands separator.
  assert.deepEqual(parseCsvRows('rice,2000,500\n').rows, [{ name: 'rice', price: 2000 }])
  assert.deepEqual(parseCsvRows('pork,12000,500\n').rows, [{ name: 'pork', price: 12000 }])
})

test('parseCsvRows() reports physical line numbers, counting blanks and the header', () => {
  const text = 'Item,Price\n\n,10\nRice,\nBeans,1200\n'
  assert.deepEqual(parseCsvRows(text), { rows: [{ name: 'Beans', price: 1200 }], skipped: [3, 4] })
})

test('parseCsvRows() treats the header as data when the file starts with a blank line', () => {
  // Known quirk: the header check is keyed to physical line 1, so a leading
  // blank line turns the header into a skipped row (reported, never imported).
  assert.deepEqual(parseCsvRows('\nItem,Price\nRice,2000\n'), {
    rows: [{ name: 'Rice', price: 2000 }],
    skipped: [2],
  })
})

test('parseCsvRows() is line-based and does not support line breaks inside quotes', () => {
  // Documented limitation (not RFC-4180): Laoka's export never emits a quoted
  // newline, and a hand-edited file that has one imports nothing — the first
  // line is consumed as the header and the remainder is skipped and reported.
  assert.deepEqual(parseCsvRows('"Pork\nchop",1000\n'), { rows: [], skipped: [2] })
})

// ─── csvTitleFromFilename ────────────────────────────────────
test('csvTitleFromFilename() strips the extension and the download counter', () => {
  assert.equal(csvTitleFromFilename('Laoka_SEP_12__SEP_18(1).csv'), 'Laoka SEP 12 SEP 18')
  assert.equal(csvTitleFromFilename('Laoka_SEP_12__SEP_18 (4).csv'), 'Laoka SEP 12 SEP 18')
  assert.equal(csvTitleFromFilename('Laoka(3).csv'), 'Laoka')
  assert.equal(csvTitleFromFilename('Laoka.csv'), 'Laoka')
})

test('csvTitleFromFilename() keeps hyphens inside a date-shaped run', () => {
  assert.equal(csvTitleFromFilename('Laoka - 2026-09-12.csv'), 'Laoka 2026-09-12')
  assert.equal(csvTitleFromFilename('Laoka_2026-9-5__2026-9-11(2).csv'), 'Laoka 2026-9-5 2026-9-11')
})

test('csvTitleFromFilename() turns every other separator into a single space', () => {
  assert.equal(csvTitleFromFilename('Laoka\u2013SEP\u2014OCT.csv'), 'Laoka SEP OCT')
  assert.equal(csvTitleFromFilename('Laoka___SEP-12.csv'), 'Laoka SEP 12')
  assert.equal(csvTitleFromFilename('   Laoka   SEP 12  .csv'), 'Laoka SEP 12')
})

test('csvTitleFromFilename() tolerates odd input', () => {
  assert.equal(csvTitleFromFilename(''), '')
  assert.equal(csvTitleFromFilename(null), '')
  assert.equal(csvTitleFromFilename(undefined), '')
  assert.equal(csvTitleFromFilename('.csv'), '')
  assert.equal(csvTitleFromFilename('Laoka SEP 12'), 'Laoka SEP 12')
})

test('csvTitleFromFilename() caps the title at 120 characters', () => {
  const title = csvTitleFromFilename(`${'x'.repeat(200)}.csv`)
  assert.equal(title.length, 120)
  assert.equal(title, 'x'.repeat(120))
})
