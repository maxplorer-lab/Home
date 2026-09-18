// Small HTTP helpers shared by every route.

export function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status === undefined ? 200 : status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {})
  });
}

export function ok(data) {
  return json(Object.assign({ ok: true }, data || {}));
}

export function fail(status, message, extra) {
  return json(Object.assign({ ok: false, error: message }, extra || {}), status);
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch (err) {
    return null;
  }
}

export function text(body, status, contentType) {
  return new Response(body, {
    status: status === undefined ? 200 : status,
    headers: { 'content-type': contentType || 'text/plain; charset=utf-8' }
  });
}

// Zero padded integer from untrusted input, or null when absent/invalid.
export function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export function toStr(value, max) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return max ? s.slice(0, max) : s;
}

export function toBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}
