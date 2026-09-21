// Worker entry point. Routes API and socket traffic, and serves the single page
// app from static assets for everything else.

import { ok, fail } from './lib/http.js';
import { requireUser } from './lib/auth.js';
import { lobbyStub } from './lib/notify.js';
import { Lobby } from './durable/lobby.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import weekRoutes from './routes/weeks.js';
import shoppingRoutes from './routes/shopping.js';
import pantryRoutes from './routes/pantry.js';
import exportRoutes from './routes/exports.js';
import adminRoutes from './routes/admin.js';
import { getCatalogTree, getSettings, listWeeks, getSelectedPools, getGourmetList, getPantryTree, listPantryToBuy, getCurrentPantryTrip, getLastPantryTrip } from './data/queries.js';
import { weekStartFor, todayInNairobi, addDays } from './lib/dates.js';

export { Lobby };

// Auth routes come first and are marked public: they are how a session is
// obtained. Everything else needs one.
const ROUTES = [].concat(authRoutes, catalogRoutes, weekRoutes, shoppingRoutes, pantryRoutes, exportRoutes, adminRoutes);

function matchRoute(pattern, parts) {
  const expected = pattern.split('/').filter(Boolean);
  if (expected.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].charAt(0) === ':') {
      params[expected[i].slice(1)] = decodeURIComponent(parts[i]);
    } else if (expected[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

function findRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchRoute(route.pattern, parts);
    if (params) return { route: route, params: params };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      return lobbyStub(env).fetch(request);
    }

    if (url.pathname === '/api/bootstrap') {
      const auth = await requireUser(request, env);
      if (auth.error) return auth.error;
      const settings = await getSettings(env);
      const weeks = await listWeeks(env);
      const today = todayInNairobi();
      const currentStart = weekStartFor(today);

      // The earliest Saturday from this week onward that has no week row yet.
      // Without it, archiving the current week left the only "start a week"
      // button pointing at a week that can never be reopened.
      const takenRows = await env.DB.prepare('SELECT start_date FROM weeks').all();
      const taken = {};
      for (const r of (takenRows.results || [])) taken[r.start_date] = true;
      let nextStart = currentStart;
      for (let i = 0; i < 60 && taken[nextStart]; i++) nextStart = addDays(nextStart, 7);

      return ok({
        user: auth.user,
        today: today,
        currentWeekStart: currentStart,
        nextWeekStart: nextStart,
        settings: settings,
        // The MEAL catalogue only (`is_pantry = 0` inside getCatalogTree): what a
        // week can be planned from. The pantry ships beside it as its own tree.
        catalog: await getCatalogTree(env),
        gourmet: await getGourmetList(env),
        weeks: weeks,
        pools: await getSelectedPools(env),
        // The second domain: shelves to count, and what below-reorder level says
        // to buy. Not a week, not a plan -- see queries.js.
        pantry: await getPantryTree(env),
        pantryToBuy: await listPantryToBuy(env),
        pantryTrip: await getCurrentPantryTrip(env, false),
        pantryLastTrip: await getLastPantryTrip(env)
      });
    }

    if (url.pathname.indexOf('/api/') === 0) {
      const found = findRoute(request.method, url.pathname);
      if (!found) return fail(404, 'no such endpoint');
      const context = {
        request: request,
        env: env,
        url: url,
        params: found.params,
        user: null,
        // The Worker execution context, so a route can hand background work
        // such as the realtime broadcast to waitUntil.
        exec: ctx
      };
      if (!found.route.public) {
        const auth = await requireUser(request, env);
        if (auth.error) return auth.error;
        context.user = auth.user;
      }
      try {
        return await found.route.handler(context);
      } catch (err) {
        return fail(500, 'request failed: ' + (err && err.message ? err.message : 'unknown error'));
      }
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404 && request.method === 'GET') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: 'GET' }));
    }
    return asset;
  }
};
