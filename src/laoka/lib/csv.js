// The CSV export is a frozen interface consumed by the sompitra project.
// Shape: a header row, then one row per priced shopping line, sorted A to Z by
// item name across all groups. Unpriced lines never reach the file.

export const CSV_HEADER = ['Item', 'Price'];

// RFC 4180: quote only when the value contains a delimiter, quote or newline.
export function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.indexOf(',') === -1 && s.indexOf('"') === -1 && s.indexOf('\n') === -1 && s.indexOf('\r') === -1) {
    return s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

export function buildCsv(lines) {
  const rows = (lines || [])
    .filter(function (l) { return l && l.price !== null && l.price !== undefined && Number(l.price) > 0; })
    .map(function (l) { return { name: String(l.name), price: Math.trunc(Number(l.price)) }; });

  rows.sort(function (a, b) {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  const out = [CSV_HEADER.map(csvField).join(',')];
  for (const r of rows) out.push(csvField(r.name) + ',' + csvField(r.price));
  return out.join('\r\n') + '\r\n';
}

// The filename is the only identity a week has for sompitra, so the shape is
// fixed: Laoka_<MON>_<DD>__<MON>_<DD>.csv, Saturday then Friday, month in
// capitals, day padded to two digits so the name is fixed width.
export const MONTH_STAMPS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dayStamp(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return MONTH_STAMPS[d.getUTCMonth()] + '_' + String(d.getUTCDate()).padStart(2, '0');
}

export function exportFilename(startDate, endDate) {
  return 'Laoka_' + dayStamp(startDate) + '__' + dayStamp(endDate) + '.csv';
}

export function contentDisposition(filename) {
  return 'attachment; filename="' + filename.replace(/"/g, '') + '"';
}
