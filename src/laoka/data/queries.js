// Every database read and write lives here so the route modules stay thin.

import { todayInNairobi, isDayEditable } from '../lib/dates.js';
import { exportFilename } from '../lib/csv.js';

const WEEK_COLUMNS = 'id, start_date, end_date, status, budget, exported_at, updated_at, generation, confirmed_at';

export async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of (rows.results || [])) out[r.key] = r.value;
  return out;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2'
  ).bind(key, String(value)).run();
}

export async function touchWeek(env, weekId) {
  await env.DB.prepare("UPDATE weeks SET updated_at = datetime('now') WHERE id = ?1").bind(weekId).run();
}

export async function getWeekById(env, weekId) {
  return await env.DB.prepare('SELECT ' + WEEK_COLUMNS + ' FROM weeks WHERE id = ?1').bind(weekId).first();
}

export async function getWeekByStart(env, startDate) {
  return await env.DB.prepare('SELECT ' + WEEK_COLUMNS + ' FROM weeks WHERE start_date = ?1').bind(startDate).first();
}

export async function listWeeks(env) {
  const rows = await env.DB.prepare(
    'SELECT ' + WEEK_COLUMNS + ' FROM weeks WHERE status != ?1 ORDER BY start_date DESC'
  ).bind('archived').all();
  return rows.results || [];
}

// ---------------------------------------------------------------- catalog

export async function getCatalogTree(env) {
  const sql = 'SELECT g.id AS group_id, g.name AS group_name, g.is_pantry, g.sort_order AS group_sort, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.icon AS subgroup_icon, s.slot_role, s.sort_order AS subgroup_sort, ' +
    'i.id AS item_id, i.name AS item_name, i.selected, i.notes, i.sort_order AS item_sort ' +
    'FROM groups g ' +
    'LEFT JOIN subgroups s ON s.group_id = g.id AND s.deleted_at IS NULL ' +
    'LEFT JOIN items i ON i.subgroup_id = s.id AND i.deleted_at IS NULL ' +
    'WHERE g.deleted_at IS NULL ' +
    'ORDER BY g.sort_order, g.id, s.sort_order, s.id, i.sort_order, i.id';
  const rows = await env.DB.prepare(sql).all();

  const groups = [];
  const byGroup = new Map();
  const bySubgroup = new Map();

  for (const r of (rows.results || [])) {
    let g = byGroup.get(r.group_id);
    if (!g) {
      g = { id: r.group_id, name: r.group_name, isPantry: !!r.is_pantry, subgroups: [] };
      byGroup.set(r.group_id, g);
      groups.push(g);
    }
    if (r.subgroup_id === null || r.subgroup_id === undefined) continue;
    let s = bySubgroup.get(r.subgroup_id);
    if (!s) {
      s = { id: r.subgroup_id, name: r.subgroup_name, icon: r.subgroup_icon || '', slotRole: r.slot_role, groupId: g.id, groupName: g.name, items: [] };
      bySubgroup.set(r.subgroup_id, s);
      g.subgroups.push(s);
    }
    if (r.item_id === null || r.item_id === undefined) continue;
    s.items.push({ id: r.item_id, name: r.item_name, selected: !!r.selected, notes: r.notes, subgroupId: s.id });
  }
  return groups;
}

// Eligible draw pools, keyed by slot role. Only selected, live items qualify.
export async function getSelectedPools(env) {
  const sql = 'SELECT s.slot_role, i.id FROM items i ' +
    'JOIN subgroups s ON s.id = i.subgroup_id AND s.deleted_at IS NULL ' +
    'JOIN groups g ON g.id = s.group_id AND g.deleted_at IS NULL ' +
    'WHERE i.deleted_at IS NULL AND i.selected = 1 AND s.slot_role IN (?1, ?2, ?3)';
  const rows = await env.DB.prepare(sql).bind('protein', 'side', 'salad').all();
  const pools = { protein: [], side: [], salad: [] };
  for (const r of (rows.results || [])) {
    if (pools[r.slot_role]) pools[r.slot_role].push(r.id);
  }
  return pools;
}

export async function getGourmetIds(env) {
  const rows = await env.DB.prepare('SELECT id FROM gourmet WHERE deleted_at IS NULL ORDER BY id').all();
  return (rows.results || []).map(function (r) { return r.id; });
}

export async function getGourmetList(env) {
  const rows = await env.DB.prepare(
    'SELECT id, title, link, ingredients, notes, ' +
    '(image IS NOT NULL) AS has_image, image_updated_at ' +
    'FROM gourmet WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE'
  ).all();
  return (rows.results || []).map(function (r) {
    return {
      id: r.id,
      title: r.title,
      link: r.link,
      ingredients: r.ingredients,
      notes: r.notes,
      hasImage: !!r.has_image,
      imageUpdatedAt: r.image_updated_at
    };
  });
}

export async function getPantryItemIds(env) {
  const sql = 'SELECT i.id FROM items i ' +
    'JOIN subgroups s ON s.id = i.subgroup_id AND s.deleted_at IS NULL ' +
    'JOIN groups g ON g.id = s.group_id AND g.deleted_at IS NULL ' +
    'WHERE i.deleted_at IS NULL AND g.is_pantry = 1';
  const rows = await env.DB.prepare(sql).all();
  return (rows.results || []).map(function (r) { return r.id; });
}

// ------------------------------------------------------------ wishlists

export async function listPlans(env, weekId) {
  const rows = await env.DB.prepare(
    'SELECT id, label, is_selected FROM plans WHERE week_id = ?1 ORDER BY id'
  ).bind(weekId).all();
  return rows.results || [];
}

export async function getSelectedPlan(env, weekId) {
  return await env.DB.prepare(
    'SELECT id, label, is_selected FROM plans WHERE week_id = ?1 AND is_selected = 1'
  ).bind(weekId).first();
}

export async function insertPlan(env, weekId, label, days, gourmetIds) {
  const planRow = await env.DB.prepare('INSERT INTO plans (week_id, label) VALUES (?1, ?2)')
    .bind(weekId, label).run();
  const planId = planRow.meta.last_row_id;

  const dayStatements = [];
  for (const day of days) {
    dayStatements.push(
      env.DB.prepare('INSERT INTO plan_days (plan_id, day_date, day_type, gourmet_id, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(planId, day.date, day.dayType, day.gourmetId, days.indexOf(day))
    );
  }
  const inserted = await env.DB.batch(dayStatements);

  const slotStatements = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (day.dayType !== 'normal') continue;
    const dayId = inserted[i].meta.last_row_id;
    for (const role of ['protein', 'side', 'salad']) {
      slotStatements.push(
        env.DB.prepare('INSERT INTO plan_day_items (plan_day_id, slot, item_id) VALUES (?1, ?2, ?3)')
          .bind(dayId, role, day.slots[role])
      );
    }
  }
  if (slotStatements.length) await env.DB.batch(slotStatements);
  return planId;
}

export async function selectPlan(env, weekId, planId) {
  await env.DB.batch([
    env.DB.prepare('UPDATE plans SET is_selected = 0 WHERE week_id = ?1').bind(weekId),
    env.DB.prepare('UPDATE plans SET is_selected = 1 WHERE id = ?1 AND week_id = ?2').bind(planId, weekId)
  ]);
}

export async function discardUnselectedPlans(env, weekId) {
  await env.DB.prepare('DELETE FROM plans WHERE week_id = ?1 AND is_selected = 0').bind(weekId).run();
}

// -------------------------------------------------------------- reading

export async function getPlanDays(env, planId) {
  const sql = 'SELECT d.id, d.day_date, d.day_type, d.gourmet_id, g.title AS gourmet_title, ' +
    'g.link AS gourmet_link, g.ingredients AS gourmet_ingredients, ' +
    'g.image_updated_at AS gourmet_image_at ' +
    'FROM plan_days d LEFT JOIN gourmet g ON g.id = d.gourmet_id ' +
    'WHERE d.plan_id = ?1 ORDER BY d.day_date';
  const dayRows = await env.DB.prepare(sql).bind(planId).all();
  const days = (dayRows.results || []).map(function (d) {
    return {
      id: d.id,
      date: d.day_date,
      type: d.day_type,
      gourmetId: d.gourmet_id,
      gourmetTitle: d.gourmet_title,
      gourmetLink: d.gourmet_link,
      gourmetIngredients: d.gourmet_ingredients,
      gourmetImageAt: d.gourmet_image_at,
      slots: {}
    };
  });
  if (!days.length) return days;

  const slotSql = 'SELECT di.plan_day_id, di.slot, di.item_id, i.name AS item_name, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.icon AS subgroup_icon, s.slot_role, ' +
    'gr.id AS group_id, gr.name AS group_name ' +
    'FROM plan_day_items di ' +
    'LEFT JOIN items i ON i.id = di.item_id ' +
    'LEFT JOIN subgroups s ON s.id = i.subgroup_id ' +
    'LEFT JOIN groups gr ON gr.id = s.group_id ' +
    'WHERE di.plan_day_id IN (SELECT id FROM plan_days WHERE plan_id = ?1)';
  const slotRows = await env.DB.prepare(slotSql).bind(planId).all();

  const index = new Map();
  for (const d of days) index.set(d.id, d);
  for (const r of (slotRows.results || [])) {
    const day = index.get(r.plan_day_id);
    if (!day) continue;
    day.slots[r.slot] = r.item_id === null ? null : {
      itemId: r.item_id,
      name: r.item_name,
      subgroupId: r.subgroup_id,
      subgroupName: r.subgroup_name,
      icon: r.subgroup_icon || '',
      slotRole: r.slot_role,
      groupId: r.group_id,
      groupName: r.group_name
    };
  }
  return days;
}

export async function getShoppingLines(env, weekId) {
  const sql = 'SELECT l.id, l.item_id, l.origin, l.price, i.name AS item_name, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.slot_role, gr.id AS group_id, gr.name AS group_name, ' +
    'gr.sort_order AS group_sort, gr.is_pantry ' +
    'FROM shopping_lines l ' +
    'JOIN items i ON i.id = l.item_id ' +
    'JOIN subgroups s ON s.id = i.subgroup_id ' +
    'JOIN groups gr ON gr.id = s.group_id ' +
    'WHERE l.week_id = ?1 ' +
    'ORDER BY gr.sort_order, gr.id, i.name COLLATE NOCASE';
  const rows = await env.DB.prepare(sql).bind(weekId).all();
  return (rows.results || []).map(function (r) {
    return {
      id: r.id,
      itemId: r.item_id,
      name: r.item_name,
      groupId: r.group_id,
      groupName: r.group_name,
      subgroupName: r.subgroup_name,
      slotRole: r.slot_role,
      isPantry: !!r.is_pantry,
      origin: r.origin,
      price: r.price,
      bought: r.price !== null && r.price > 0,
      count: 0
    };
  });
}

export async function getPlanItemCounts(env, planId) {
  const sql = 'SELECT di.item_id, COUNT(*) AS n FROM plan_day_items di ' +
    'JOIN plan_days d ON d.id = di.plan_day_id ' +
    'WHERE d.plan_id = ?1 AND di.item_id IS NOT NULL GROUP BY di.item_id';
  const rows = await env.DB.prepare(sql).bind(planId).all();
  const counts = {};
  for (const r of (rows.results || [])) counts[r.item_id] = r.n;
  return counts;
}

// Rebuilds the week shopping lines from the saved plan plus Pantry, preserving
// the price of every line that survives. An item swapped out of its last day
// loses its line and its price, exactly as the spec requires.
export async function syncShoppingLines(env, weekId) {
  const plan = await getSelectedPlan(env, weekId);
  const desired = new Map();

  if (plan) {
    const counts = await getPlanItemCounts(env, plan.id);
    for (const itemId of Object.keys(counts)) desired.set(Number(itemId), 'plan');
  }
  const pantryIds = await getPantryItemIds(env);
  for (const itemId of pantryIds) if (!desired.has(itemId)) desired.set(itemId, 'pantry');

  const existing = await env.DB.prepare('SELECT id, item_id, origin FROM shopping_lines WHERE week_id = ?1')
    .bind(weekId).all();
  const current = new Map();
  for (const r of (existing.results || [])) current.set(r.item_id, r);

  const statements = [];
  for (const [itemId, origin] of desired) {
    const row = current.get(itemId);
    if (!row) {
      statements.push(env.DB.prepare('INSERT INTO shopping_lines (week_id, item_id, origin) VALUES (?1, ?2, ?3)')
        .bind(weekId, itemId, origin));
    } else if (row.origin !== origin) {
      statements.push(env.DB.prepare('UPDATE shopping_lines SET origin = ?1 WHERE id = ?2').bind(origin, row.id));
    }
  }
  for (const [itemId, row] of current) {
    if (!desired.has(itemId)) {
      statements.push(env.DB.prepare('DELETE FROM shopping_lines WHERE id = ?1').bind(row.id));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

export function summarise(lines) {
  let total = 0;
  let priced = 0;
  for (const l of lines) {
    if (l.price !== null && l.price !== undefined && l.price > 0) {
      total += l.price;
      priced++;
    }
  }
  // Bought and priced are the same thing: a price is the only way to mark a
  // line as picked up.
  return {
    total: total,
    priced: priced,
    bought: priced,
    count: lines.length,
    remaining: lines.length - priced,
    unpricedBought: 0
  };
}

export async function buildWeekState(env, week, now) {
  const plan = await getSelectedPlan(env, week.id);
  const today = todayInNairobi(now);

  let days = [];
  let counts = {};
  if (plan) {
    days = await getPlanDays(env, plan.id);
    counts = await getPlanItemCounts(env, plan.id);
  }
  const settled = !!week.confirmed_at;
  for (const d of days) {
    // While the week is still a template every day can change, which is what
    // makes it usable in a shop. Confirming locks only what has passed.
    d.editable = settled ? d.date >= today : true;
    d.dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      new Date(d.date + 'T00:00:00Z').getUTCDay()
    ];
    if (d.type === 'gourmet') {
      d.slots = null;
    } else {
      for (const role of ['protein', 'side', 'salad']) {
        if (!(role in d.slots)) d.slots[role] = null;
      }
    }
  }

  const lines = await getShoppingLines(env, week.id);
  for (const l of lines) l.count = counts[l.itemId] || 0;
  const totals = summarise(lines);

  // An unsaved candidate has no shopping list yet, so its days are the only
  // way to see what it proposes. They must travel with it.
  const planRows = await listPlans(env, week.id);
  const candidates = [];
  for (const p of planRows) {
    const isSelected = !!p.is_selected;
    candidates.push({
      id: p.id,
      label: p.label,
      isSelected: isSelected,
      // The saved plan's days are already loaded above; fetching them again
      // here cost two queries on every state read.
      days: isSelected ? days : await getPlanDays(env, p.id)
    });
  }

  return {
    week: {
      id: week.id,
      startDate: week.start_date,
      endDate: week.end_date,
      status: week.status,
      budget: week.budget === null || week.budget === undefined ? null : Number(week.budget),
      exportedAt: week.exported_at,
      updatedAt: week.updated_at,
      confirmedAt: week.confirmed_at || null,
      today: today,
      // The exact name the download will carry, so a preview cannot drift from
      // what the browser actually saves.
      exportName: exportFilename(week.start_date, week.end_date)
    },
    planId: plan ? plan.id : null,
    candidates: candidates,
    days: days,
    shopping: lines,
    totals: totals
  };
}
