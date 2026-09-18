// All week maths runs against a fixed offset. Africa/Nairobi is UTC+3 with no
// daylight saving, so a constant offset is exact and avoids any tz database.

export const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

// Today as YYYY-MM-DD in Nairobi, regardless of the server clock.
export function todayInNairobi(now) {
  const t = now === undefined ? Date.now() : now;
  return new Date(t + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

// Day of week in Nairobi: 0=Sunday ... 6=Saturday.
export function weekdayInNairobi(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

// The Saturday that opens the week containing dateStr.
export function weekStartFor(dateStr) {
  const day = weekdayInNairobi(dateStr);
  const sinceSaturday = (day + 1) % 7;
  return addDays(dateStr, -sinceSaturday);
}

export function weekEndFor(startDate) {
  return addDays(startDate, 6);
}

// Saturday first, then Sunday, then Monday to Friday.
export function weekDates(startDate) {
  const out = [];
  for (let i = 0; i < 7; i++) out.push(addDays(startDate, i));
  return out;
}

export function isSunday(dateStr) {
  return weekdayInNairobi(dateStr) === 0;
}

// Locking rule: editable while the day is today or later in Nairobi.
export function isDayEditable(dayDate, now) {
  return dayDate >= todayInNairobi(now);
}

export function dayName(dateStr) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekdayInNairobi(dateStr)];
}

// Friday afternoon in Nairobi opens next week planning. A week archives when
// the following Saturday begins.
export function isClosingAfternoon(now) {
  const t = now === undefined ? Date.now() : now;
  const local = new Date(t + NAIROBI_OFFSET_MS);
  return local.getUTCDay() === 5 && local.getUTCHours() >= 12;
}
