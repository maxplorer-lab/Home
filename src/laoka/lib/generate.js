// Plan generation. Pure, deterministic under an injected random source, so the
// rules can be unit tested without a Worker or a database.
//
// Rules taken from the spec:
//  - one draw per slot role (protein, side, salad) for each of the six normal days
//  - only selected items are eligible; the caller supplies those pools
//  - repeats are allowed and expected; there is no spacing or cooldown rule
//  - a slot stays empty when its pool is empty
//  - each candidate week picks its own Sunday Gourmet title

import { isSunday } from './dates.js';

export const SLOT_ROLES = ['protein', 'side', 'salad'];

function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

function pickOne(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

// Draws evenly from a pool by consuming shuffled bags, refilling when exhausted.
// A pool of three over six days yields each item exactly twice.
export function createBag(pool, rand) {
  let bag = [];
  return function next() {
    if (pool.length === 0) return null;
    if (bag.length === 0) bag = shuffle(pool.slice(), rand);
    return bag.pop();
  };
}

export function generatePlan(input) {
  const rand = input.rand || Math.random;
  const dates = input.dates || [];
  const pools = input.pools || {};
  const gourmetIds = input.gourmetIds || [];

  const bags = {};
  for (const role of SLOT_ROLES) bags[role] = createBag(pools[role] || [], rand);

  const days = [];
  for (const date of dates) {
    if (isSunday(date)) {
      days.push({
        date: date,
        dayType: 'gourmet',
        gourmetId: gourmetIds.length ? pickOne(gourmetIds, rand) : null,
        slots: null
      });
      continue;
    }
    const slots = {};
    for (const role of SLOT_ROLES) slots[role] = bags[role]();
    days.push({ date: date, dayType: 'normal', gourmetId: null, slots: slots });
  }
  return days;
}

// Deterministic random source, used by tests and by seeded generation.
export function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
