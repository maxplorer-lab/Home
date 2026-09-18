// Laoka single page app. Mobile first.
//
// The board is shared: whoever ticks or prices a line writes to D1, the Worker
// pings the Durable Object, and every other device pulls the new state. The
// socket only ever carries a notification.

var SLOT_ROLES = ['protein', 'side', 'salad'];
var SLOT_LABEL = { protein: 'Protein', side: 'Side', salad: 'Salad' };
var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

var state = {
  bootstrap: null,
  week: null,
  tab: 'plan',
  history: null,
  historyDetail: null,
  users: null,
  invites: null,
  showPantry: false,
  auth: null,
  authMode: null,
  editingDay: null,
  deferred: false
};

// ------------------------------------------------------------------ dom

function h(tag, props) {
  var el = document.createElement(tag);
  if (props) {
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, String(v));
    }
  }
  for (var i = 2; i < arguments.length; i++) appendKids(el, arguments[i]);
  return el;
}

function appendKids(el, kid) {
  if (kid === null || kid === undefined || kid === false || kid === true) return;
  if (Array.isArray(kid)) {
    for (var i = 0; i < kid.length; i++) appendKids(el, kid[i]);
    return;
  }
  if (kid instanceof Node) { el.appendChild(kid); return; }
  el.appendChild(document.createTextNode(String(kid)));
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// A thin top progress bar, so a slow tap on a phone in a shop reads as
// "working" rather than "did nothing".
var inFlight = 0;
function progress(on) {
  var el = document.getElementById('nav-progress');
  if (el) el.className = on ? 'on' : '';
}

async function api(method, path, body) {
  var opts = { method: method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  inFlight++;
  progress(true);
  try {
    var res = await fetch('/laoka' + path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) ? data.error : ('request failed (' + res.status + ')'));
    }
    return data;
  } finally {
    inFlight--;
    if (inFlight <= 0) { inFlight = 0; progress(false); }
  }
}

window.__laokaTheme = function () {
  var root = document.documentElement;
  root.classList.toggle('dark');
  try { localStorage.setItem('laoka-theme', root.classList.contains('dark') ? 'dark' : 'light'); } catch (e) {}
  var btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = root.classList.contains('dark') ? '☀️' : '🌙';
};

var toastTimer = null;
function toast(message, isError) {
  var el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' err' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, isError ? 5200 : 2200);
}

function reportError(e) { toast(e && e.message ? e.message : String(e), true); }

function dayOfWeek(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); }
function shortDate(dateStr) {
  var d = new Date(dateStr + 'T00:00:00Z');
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
}

// Rendering is deferred only while somebody is typing or choosing, so a
// text field never loses focus mid-edit.
function isTyping() {
  var a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
  if (a.tagName === 'INPUT') {
    var t = String(a.type || 'text').toLowerCase();
    return t === 'text' || t === 'search' || t === 'tel' || t === 'number' || t === 'password';
  }
  return false;
}

function modalSheet(nodes) {
  var modal = document.getElementById('modal');
  clear(modal);
  modal.appendChild(h('div', { class: 'sheet' }, nodes));
  modal.className = 'modal';
  return modal;
}

function closeModal() {
  var modal = document.getElementById('modal');
  modal.className = 'modal hidden';
  clear(modal);
}

// A small form builder, so catalog, gourmet, user and settings dialogs all
// share one mobile friendly sheet.
function formModal(title, fields, submitLabel) {
  return new Promise(function (resolve) {
    pendingImage = { image: undefined, imageType: undefined };
    var inputs = {};
    var body = [];
    for (var i = 0; i < fields.length; i++) {
      (function (f) {
        body.push(h('label', { class: 'f', text: f.label + (f.required ? ' *' : '') }));
        var el;
        if (f.type === 'image') {
          el = imageField(f);
        } else if (f.type === 'textarea') {
          el = h('textarea', { value: f.value || '', placeholder: f.placeholder || '', rows: f.rows || 8 });
        } else if (f.type === 'select') {
          el = h('select', {});
          for (var j = 0; j < f.options.length; j++) {
            var o = f.options[j];
            var opt = h('option', { value: String(o.value), text: o.label });
            if (String(o.value) === String(f.value)) opt.selected = true;
            el.appendChild(opt);
          }
        } else {
          el = h('input', {
            type: f.type || 'text',
            value: f.value === null || f.value === undefined ? '' : f.value,
            placeholder: f.placeholder || '',
            inputmode: f.inputmode || null,
            autocomplete: 'off'
          });
        }
        inputs[f.name] = el;
        body.push(el);
        if (f.hint) body.push(h('p', { class: 'note', text: f.hint }));
      })(fields[i]);
    }

    var done = false;
    function finish(result) {
      if (done) return;
      done = true;
      closeModal();
      resolve(result);
    }
    function submit() {
      var values = {};
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var v = f.type === 'image' ? pendingImage.image : inputs[f.name].value;
        if (f.required && !String(v).trim()) {
          toast(f.label + ' is required', true);
          inputs[f.name].focus();
          return;
        }
        values[f.name] = v;
      }
      finish(values);
    }

    body.push(h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { class: 'primary', style: 'flex:1', text: submitLabel || 'Save', onclick: submit }),
      h('button', { text: 'Cancel', onclick: function () { finish(null); } })
    ));
    modalSheet(h('div', null, h('h2', { text: title }), body));
    var first = inputs[fields[0].name];
    setTimeout(function () { if (first && first.focus) first.focus(); }, 40);
  });
}

// A picture waiting to be sent with the next recipe save. undefined means
// "leave it alone", an empty string means "remove it".
var pendingImage = { image: undefined, imageType: undefined };

// Downscales in the browser before upload. A 4 MB phone photo becomes roughly
// 150 to 300 KB, which keeps the D1 row far below its 2 MB ceiling.
function shrinkImage(file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth || img.width;
        var hgt = img.naturalHeight || img.height;
        var scale = Math.min(1, maxDim / Math.max(w, hgt));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(hgt * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        var dataUrl = canvas.toDataURL('image/jpeg', quality);
        URL.revokeObjectURL(url);
        resolve({ base64: dataUrl.split(',')[1], type: 'image/jpeg' });
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}

function imageField(f) {
  var preview = h('img', { src: f.value || '', alt: '' });
  if (!f.value) preview.className = 'hidden';
  var file = h('input', { type: 'file', accept: 'image/*' });
  file.addEventListener('change', function () {
    var chosen = this.files && this.files[0];
    if (!chosen) return;
    shrinkImage(chosen, 1280, 0.82).then(function (shrunk) {
      pendingImage.image = shrunk.base64;
      pendingImage.imageType = shrunk.type;
      preview.src = 'data:' + shrunk.type + ';base64,' + shrunk.base64;
      preview.className = '';
    }).catch(function () { toast('That file could not be read as a picture', true); });
  });
  return h('div', { class: 'photo-pick' },
    preview,
    h('label', { class: 'btn btnfile' }, h('span', { text: '📷 Choose' }), file),
    h('button', {
      type: 'button', class: 'tiny danger', text: 'Remove',
      onclick: function () {
        pendingImage.image = '';
        pendingImage.imageType = null;
        preview.src = '';
        preview.className = 'hidden';
      }
    })
  );
}

function confirmAction(title, message, confirmLabel) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(r) { if (done) return; done = true; closeModal(); resolve(r); }
    modalSheet([
      h('h2', { text: title }),
      h('p', { class: 'muted', text: message }),
      h('div', { class: 'row', style: 'margin-top:16px' },
        h('button', { class: 'primary danger', style: 'flex:1', text: confirmLabel || 'Delete', onclick: function () { finish(true); } }),
        h('button', { text: 'Cancel', onclick: function () { finish(false); } })
      )
    ]);
  });
}

// --------------------------------------------------------------- catalog

function catalogGroups() { return state.bootstrap ? state.bootstrap.catalog : []; }

// The plan colours an ingredient by the slot it fills, so a side and a raw
// salad are never the same shade even though both live under Sides.
var ROLE_CLASS = { protein: 'g0', side: 'g1', salad: 'g2', none: 'g3' };

function roleClass(role) {
  return ROLE_CLASS[role] || 'g4';
}

// A type keeps a colour of its own for headings: Protein blue, Sides amber,
// Pantry violet, and any type added later cycles the rest of the palette.
function typeClassById(groupId) {
  var groups = catalogGroups();
  var spare = ['g0', 'g1', 'g2', 'g4'];
  var n = 0;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].isPantry) continue;
    if (groups[i].id === groupId) return spare[n % spare.length];
    n++;
  }
  return 'g3';
}

function findSubgroup(subgroupId) {
  var groups = catalogGroups();
  for (var i = 0; i < groups.length; i++) {
    for (var j = 0; j < groups[i].subgroups.length; j++) {
      if (groups[i].subgroups[j].id === subgroupId) return groups[i].subgroups[j];
    }
  }
  return null;
}

function itemsForRole(role) {
  var out = [];
  var groups = catalogGroups();
  for (var i = 0; i < groups.length; i++) {
    for (var j = 0; j < groups[i].subgroups.length; j++) {
      var sub = groups[i].subgroups[j];
      if (sub.slotRole !== role) continue;
      for (var k = 0; k < sub.items.length; k++) {
        out.push({ id: sub.items[k].id, name: sub.items[k].name, selected: sub.items[k].selected, subgroup: sub.name, groupId: groups[i].id });
      }
    }
  }
  out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
  return out;
}

function poolCounts() {
  var p = state.bootstrap ? state.bootstrap.pools : { protein: [], side: [], salad: [] };
  return { protein: (p.protein || []).length, side: (p.side || []).length, salad: (p.salad || []).length };
}

// ------------------------------------------------------------ data flow

async function refreshBootstrap() { state.bootstrap = await api('GET', '/api/bootstrap'); }

async function loadWeek(weekId) {
  if (!weekId) { state.week = null; return; }
  state.week = await api('GET', '/api/state?week=' + encodeURIComponent(weekId));
}

function applyState(data) {
  state.week = data;
  state.lastSelfWrite = Date.now();
  if (isTyping()) { state.deferred = true; updateTotalsOnly(); return; }
  render();
}

// -------------------------------------------------------------- realtime

var notifyTimer = null;

// Reconnects back off, because a socket that keeps being refused, most often
// because the session has gone, would otherwise retry every few seconds
// forever and quietly hammer the Worker.
var socketFailures = 0;
var socketTimer = null;

function connectSocket() {
  if (socketTimer) { clearTimeout(socketTimer); socketTimer = null; }
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws;
  try { ws = new WebSocket(proto + '//' + location.host + '/laoka-ws'); }
  catch (e) { scheduleReconnect(); return; }

  ws.onopen = function () { socketFailures = 0; };
  ws.onmessage = function (ev) {
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(function () { notifyTimer = null; applyRemote(msg); }, 400);
  };
  ws.onclose = function () { scheduleReconnect(); };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}

function scheduleReconnect() {
  socketFailures++;
  var delay = Math.min(60000, 2000 * Math.pow(2, Math.min(socketFailures, 5)));
  if (socketTimer) clearTimeout(socketTimer);
  socketTimer = setTimeout(connectSocket, delay);
}

async function applyRemote(msg) {
  if (!state.week) return;
  // A notification from our own write arrives around the same time as its
  // response, so ignore the echo rather than refetching what we already have.
  if (Date.now() - (state.lastSelfWrite || 0) < 1200) return;
  if (msg && msg.weekId && msg.weekId !== state.week.week.id && !msg.archived) return;
  if (msg && msg.updatedAt && state.week.week.updatedAt === msg.updatedAt) return;
  try {
    // A price or swap only changes the week, so the catalog tree is not
    // refetched. Anything else may have moved the catalog or the settings.
    if (msg && msg.kind === 'lines') {
      await loadWeek(state.week.week.id);
    } else {
      await refreshBootstrap();
      await loadWeek(state.week.week.id);
    }
  } catch (e) { return; }
  if (isTyping()) { state.deferred = true; updateTotalsOnly(); return; }
  render();
}

// Refetching on focus and reconnect is what keeps a device honest when its
// socket was suspended in a pocket and it missed a notification.
async function softRefresh() {
  if (!state.week) return;
  try {
    await refreshBootstrap();
    await loadWeek(state.week.week.id);
    if (!isTyping()) render();
  } catch (e) { /* keep the last good state */ }
}

window.addEventListener('online', softRefresh);
document.addEventListener('visibilitychange', function () { if (!document.hidden) softRefresh(); });
document.addEventListener('focusout', function () {
  if (!state.deferred) return;
  setTimeout(function () {
    if (isTyping()) return;
    state.deferred = false;
    render();
  }, 140);
});

// ----------------------------------------------------------------- boot

async function boot() {
  var me = null;
  try { me = await api('GET', '/api/auth/me'); }
  catch (e) {
    // Inside the Home super app the central login owns sign-in: a "not
    // signed in" answer means there is no Home session at all — go get one.
    if (String(e.message || '').indexOf('not signed in') !== -1) { window.top.location.href = '/login'; return; }
    clear(document.getElementById('view')).appendChild(h('p', { class: 'muted', text: 'Could not reach the server: ' + e.message }));
    return;
  }
  if (!me.user) {
    // Inside the Home super app there is no embedded login: without a
    // session the central login owns the door.
    window.top.location.href = '/login';
    return;
  }
  state.auth = null;
  try { await refreshBootstrap(); }
  catch (e) {
    clear(document.getElementById('view')).appendChild(h('p', { class: 'muted', text: 'Could not load: ' + e.message }));
    return;
  }
  // Open on the week that contains today when there is one, rather than on
  // whichever was created most recently.
  var weeks = state.bootstrap.weeks || [];
  var pick = null;
  for (var i = 0; i < weeks.length; i++) {
    if (weeks[i].start_date === state.bootstrap.currentWeekStart) { pick = weeks[i]; break; }
  }
  if (!pick && weeks.length) pick = weeks[0];
  if (pick) await loadWeek(pick.id);
  render();
  connectSocket();
}

var NAV = [
  ['plan', '🍽️', 'Plan'],
  ['shop', '🛒', 'Shop'],
  ['catalog', '📦', 'Catalog'],
  ['gourmet', '⭐', 'Gourmet'],
  ['history', '🕘', 'History'],
  ['settings', '⚙️', 'Settings']
];

// Shown instead of the app when there is no session. The nav is hidden, since
// nothing behind it is reachable yet.
function renderAuth(me) {
  clear(document.getElementById('topnav'));
  clear(document.getElementById('bottomnav'));
  clear(document.getElementById('weekbar'));
  clear(document.getElementById('userbar'));

  var needsSetup = !!me.needsSetup;
  var mode = state.authMode || (needsSetup ? 'setup' : 'login');
  var view = clear(document.getElementById('view'));

  var username = h('input', { type: 'text', autocomplete: 'username', placeholder: 'your name', autocapitalize: 'none' });
  var password = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: 'at least 8 characters' });
  var invite = h('input', { type: 'text', inputmode: 'numeric', placeholder: '6 digit code', maxlength: '6', style: 'letter-spacing:4px;text-align:center' });
  var setupToken = h('input', { type: 'password', autocomplete: 'off', placeholder: 'setup token' });

  var fields = [
    h('label', { class: 'f', text: 'Name' }), username,
    h('label', { class: 'f', text: 'Password' }), password
  ];
  if (mode === 'setup') {
    if (me.setupTokenRequired) {
      fields.push(h('label', { class: 'f', text: 'Setup token' }), setupToken);
      fields.push(h('p', { class: 'note', text: 'The first account becomes the admin. The setup token is the one whoever deployed this app set.' }));
    } else {
      fields.push(h('p', { class: 'note', text: 'The first account becomes the admin, so choose a password you do not use anywhere else. Everyone after this joins with an invite code.' }));
    }
  } else if (mode === 'signup') {
    fields.push(h('label', { class: 'f', text: 'Invite code' }), invite);
    fields.push(h('p', { class: 'note', text: 'An admin generates this code. It works once, and expires.' }));
  }

  var card = h('div', { class: 'card' },
    h('h2', { text: mode === 'login' ? 'Sign in' : (mode === 'setup' ? 'Create the first account' : 'Join with an invite') }),
    mode === 'setup' ? h('p', { class: 'note', style: 'margin-top:0', text: 'Nobody has signed in yet, so this account runs the household.' }) : null,
    fields,
    h('button', {
      class: 'primary wide big', style: 'margin-top:16px',
      text: mode === 'login' ? 'Sign in' : 'Create account',
      onclick: async function () {
        var payload = { username: username.value.trim(), password: password.value };
        if (mode === 'setup' && me.setupTokenRequired) payload.setupToken = setupToken.value;
        if (mode === 'signup') payload.invite = invite.value.trim();
        try {
          await api('POST', '/api/auth/' + (mode === 'login' ? 'login' : 'signup'), payload);
          toast('Welcome');
          boot();
        } catch (e) { reportError(e); }
      }
    })
  );

  var switcher = h('div', { class: 'row', style: 'justify-content:center' });
  if (mode === 'login') {
    switcher.appendChild(h('button', {
      class: 'link', text: 'I have an invite code',
      onclick: function () { state.authMode = 'signup'; renderAuth(me); }
    }));
  } else {
    switcher.appendChild(h('button', {
      class: 'link', text: 'Back to sign in',
      onclick: function () { state.authMode = 'login'; renderAuth(me); }
    }));
  }

  view.appendChild(h('div', { class: 'authwrap' },
    h('div', { class: 'brandauth', text: '🍲 Laoka' }),
    h('p', { class: 'muted', style: 'text-align:center;margin:0 0 16px', text: 'A week of dinners, decided for you.' }),
    card,
    switcher
  ));
}

function render() {
  renderTop();
  renderNav();
  var view = clear(document.getElementById('view'));
  if (state.tab === 'plan') view.appendChild(renderPlan());
  else if (state.tab === 'shop') view.appendChild(renderShop());
  else if (state.tab === 'catalog') view.appendChild(renderCatalog());
  else if (state.tab === 'gourmet') view.appendChild(renderGourmet());
  // Only fetched when there is nothing cached. Calling it on every render made
  // loadHistory re-render, which called it again, forever.
  else if (state.tab === 'history') { view.appendChild(renderHistory()); if (!state.history) loadHistory(); }
  else if (state.tab === 'settings') view.appendChild(renderSettings());
  // The totals bar is fixed over the list, so the page has to reserve room for
  // it, or the last row sits under it and cannot be reached.
  document.body.classList.toggle('with-totals', state.tab === 'shop' && !!state.week && !!state.week.planId);
}

function renderTop() {
  var bar = clear(document.getElementById('weekbar'));
  var who = clear(document.getElementById('userbar'));
  var weeks = state.bootstrap.weeks || [];

  if (state.week) {
    var wk = state.week.week;
    bar.appendChild(h('span', { class: 'range', text: shortDate(wk.startDate) + ' - ' + shortDate(wk.endDate) }));
  }
  var sel = h('select', { onchange: function () { switchWeek(this.value); } });
  sel.appendChild(h('option', { value: '', text: weeks.length ? 'Switch week' : 'No open week' }));
  for (var i = 0; i < weeks.length; i++) {
    var w = weeks[i];
    var opt = h('option', { value: String(w.id), text: shortDate(w.start_date) + ' to ' + shortDate(w.end_date) });
    if (state.week && state.week.week.id === w.id) opt.selected = true;
    sel.appendChild(opt);
  }
  bar.appendChild(sel);
  if (state.week && state.week.week.exportedAt) bar.appendChild(h('span', { class: 'pill-tag', text: 'exported' }));
  if (state.bootstrap.user) who.textContent = state.bootstrap.user.display_name || state.bootstrap.user.email;
  var btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '🌙';
}

async function switchWeek(value) {
  try { await loadWeek(value ? Number(value) : null); render(); } catch (e) { reportError(e); }
}

function go(tab) {
  state.tab = tab;
  state.editingDay = null;
  render();
  window.scrollTo(0, 0);
}

function renderNav() {
  var topInner = h('div', { class: 'inner' });
  var bottomInner = h('div', { class: 'inner' });
  for (var i = 0; i < NAV.length; i++) {
    (function (key, icon, label) {
      var active = state.tab === key ? 'active' : '';
      topInner.appendChild(h('button', {
        class: active, text: icon + ' ' + label,
        onclick: function () { go(key); }
      }));
      bottomInner.appendChild(h('button', {
        class: active,
        onclick: function () { go(key); }
      }, h('span', { class: 'ico', text: icon }), h('span', { text: label })));
    })(NAV[i][0], NAV[i][1], NAV[i][2]);
  }
  clear(document.getElementById('topnav')).appendChild(topInner);
  clear(document.getElementById('bottomnav')).appendChild(bottomInner);
}

// ----------------------------------------------------------------- plan

function renderPlan() {
  var wrap = h('div');
  var b = state.bootstrap;

  if (!state.week) {
    var suggested = b.nextWeekStart || b.currentWeekStart;
    var skipped = suggested !== b.currentWeekStart;
    wrap.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'No week open' }),
      h('p', { class: 'muted', text: skipped
        ? 'This week is already archived, so the next free week is offered instead. Archiving only takes a snapshot; nothing else changes.'
        : 'Weeks run Saturday to Friday. Start the one beginning ' + shortDate(suggested) + '.' }),
      h('button', { class: 'primary wide big', text: 'Start the week of ' + shortDate(suggested), onclick: startWeek })
    ));
    return wrap;
  }

  var wk = state.week.week;
  var counts = poolCounts();
  var hasPlan = !!state.week.planId;
  var priced = (state.week.totals && state.week.totals.priced) || 0;

  // The week has three stages. A draft is a proposal, saving it makes it the
  // template the shopping list is drawn from, and confirming settles it. Only
  // the last of those locks anything, because the template has to stay
  // changeable while you are out shopping with it.
  var confirmed = !!wk.confirmedAt;
  var cands = state.week.candidates || [];
  var draft = null;
  for (var i = 0; i < cands.length; i++) if (!cands[i].isSelected) draft = cands[i];

  var head = h('div', { class: 'card' },
    h('h2', { text: shortDate(wk.startDate) + ' to ' + shortDate(wk.endDate) }),
    h('p', { class: 'note', text: confirmed
      ? 'Confirmed. Today and later can still be swapped; past days are locked.'
      : 'Today is ' + wk.today + '. Every day can still be swapped.' })
  );
  if (wk.exportedAt) {
    head.appendChild(h('div', { class: 'warn', style: 'margin-top:8px', text: 'Exported on ' + wk.exportedAt + '. Later swaps are not in that file.' }));
  }

  if (!confirmed) {
    head.appendChild(h('button', {
      class: 'primary wide big', style: 'margin-top:8px',
      text: '🎲 Generate',
      onclick: function () { generate(); }
    }));
    head.appendChild(h('p', { class: 'note', text: 'Roll as often as you like. Save a draft to make it this week\u2019s template.' }));
  }
  wrap.appendChild(head);

  if (draft) wrap.appendChild(candidateCard(draft));

  if (!hasPlan) return wrap;

  if (!confirmed) {
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', { style: 'margin:0;flex:1', text: 'This is the template' }),
        h('span', { class: 'pill-tag', text: 'not confirmed' })
      ),
      h('p', { class: 'note', text: 'Go shopping with it. Swap any day whose ingredients turn out to be unavailable or too expensive, then confirm once the week is settled.' }),
      h('button', { class: 'primary wide big', style: 'margin-top:8px', text: '✅ Confirm this week', onclick: confirmWeek })
    ));
  } else {
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: 'pill-tag', text: 'confirmed' }),
        h('span', { class: 'note', style: 'margin:0', text: wk.confirmedAt })
      )
    ));
  }

  var days = state.week.days || [];
  for (var d = 0; d < days.length; d++) wrap.appendChild(dayBlock(days[d]));

  wrap.appendChild(h('div', { class: 'card' },
    h('button', { class: 'wide', text: 'Archive this week', onclick: archiveWeek })
  ));
  return wrap;
}

function candidateCard(cand) {
  var card = h('div', { class: 'card cand' });
  card.appendChild(h('div', { class: 'row' },
    h('h2', { style: 'margin:0;flex:1', text: cand.label }),
    h('span', { class: 'pill-tag', text: 'not saved' })
  ));
  // An empty draft should say why rather than showing three blanks.
  var days = cand.days || [];
  var blanks = 0;
  for (var b = 0; b < days.length; b++) {
    if (days[b].type !== 'normal' || !days[b].slots) continue;
    for (var r = 0; r < SLOT_ROLES.length; r++) if (!days[b].slots[SLOT_ROLES[r]]) blanks++;
  }
  if (blanks) {
    card.appendChild(h('div', { class: 'warn', style: 'margin-bottom:8px', text: blanks + (blanks === 1 ? ' slot is' : ' slots are') + ' empty because nothing is available for them. Mark ingredients in the Catalog, then generate again.' }));
  } else {
    card.appendChild(h('p', { class: 'note', text: 'A draft drawn from everything available. Tap ✏️ to swap anything that reads oddly, then save it.' }));
  }
  for (var i = 0; i < days.length; i++) card.appendChild(dayBlock(days[i], 'draft'));
  card.appendChild(h('div', { class: 'row', style: 'margin-top:2px' },
    h('button', { class: 'primary', style: 'flex:1', text: 'Save for this week', onclick: function () { savePlan(cand); } }),
    h('button', { text: 'Discard', onclick: discardDraft })
  ));
  return card;
}

// Prefixes an item with its group icon, unless the icon is already part of the
// name, which happens if someone types it there instead of setting the field.
function withIcon(entry) {
  if (!entry || !entry.name) return '';
  if (!entry.icon) return entry.name;
  return entry.name.indexOf(entry.icon) === -1 ? (entry.icon + ' ' + entry.name) : entry.name;
}

function imageUrl(gourmetId, at) {
  return '/laoka/api/gourmet/' + gourmetId + '/image?v=' + encodeURIComponent(at || '');
}

// mode: 'plan' for the saved week, 'draft' for an unsaved wishlist. A draft is
// always editable, including past days, because nothing is recorded until it
// is saved.
function dayBlock(day, mode) {
  var isDraft = mode === 'draft';
  var gourmet = day.type === 'gourmet';
  var canEdit = isDraft || day.editable;
  var dim = !canEdit;
  var card = h('div', {
    class: 'daycard' + (gourmet ? ' gourmet' : '') + (dim ? ' past' : ''),
    'data-day-id': String(day.id),
    'data-day-type': day.type
  });
  var row = h('div', { class: 'dayrow' });

  // Some combinations take longer to cook than others, so a meal that suits the
  // week can still land on the wrong evening. The handle trades a day's meals
  // with another day's.
  if (canEdit && !gourmet && mode === undefined) {
    row.appendChild(h('span', {
      class: 'handle', title: 'Drag up or down to move this meal to another day',
      onpointerdown: function (ev) { startDayDrag(ev, day.id); }
    }));
  }

  row.appendChild(h('div', { class: 'datebadge' },
    h('span', { class: 'dow', text: DOW3[dayOfWeek(day.date)] }),
    h('span', { class: 'num', text: String(Number(day.date.slice(8, 10))) })
  ));

  if (gourmet) {
    if (day.gourmetId && day.gourmetImageAt) {
      row.appendChild(h('img', { class: 'thumb', src: imageUrl(day.gourmetId, day.gourmetImageAt), alt: '' }));
    }
    row.appendChild(h('div', { class: 'items' },
      h('span', { class: 'gourmet-title', text: day.gourmetTitle || 'Gourmet' })
    ));
  } else {
    var items = h('div', { class: 'items' });
    for (var i = 0; i < SLOT_ROLES.length; i++) {
      var role = SLOT_ROLES[i];
      var s = day.slots ? day.slots[role] : null;
      if (role === 'salad' && canEdit) items.appendChild(saladChip(day, s));
      else items.appendChild(s
        ? h('span', { class: 'slotchip ' + roleClass(s.slotRole), text: withIcon(s) })
        : h('span', { class: 'slotchip dim', text: 'none' }));
    }
    row.appendChild(items);
  }

  if (canEdit) {
    row.appendChild(h('button', {
      class: 'editbtn', text: '✏️', title: 'Swap an ingredient on this day',
      onclick: function () { state.editingDay = state.editingDay === day.id ? null : day.id; render(); }
    }));
  }

  card.appendChild(row);
  if (state.editingDay === day.id) card.appendChild(editorPanel(day));
  return card;
}

// Salads are chosen by default: the generator fills the slot whenever one is
// available. Tapping the cross takes the salad off this day, which also takes
// it off the shopping list.
function saladChip(day, s) {
  if (!s) {
    return h('button', {
      class: 'slotchip dim addchip', text: '+ salad',
      title: 'Put a salad back on this day',
      onclick: function (ev) { ev.stopPropagation(); openItemPicker(day, 'salad'); }
    });
  }
  return h('span', { class: 'slotchip ' + roleClass(s.slotRole) + ' chipx' },
    h('span', { text: withIcon(s) }),
    h('button', {
      class: 'chipdrop', text: '✕', title: 'No salad on this day',
      onclick: function (ev) { ev.stopPropagation(); dropSalad(day, s); }
    })
  );
}

async function dropSalad(day, s) {
  try {
    var data = await api('PATCH', '/api/days/' + day.id + '/slot', { slot: 'salad', itemId: null });
    applyState(data);
    toast('No salad on ' + DOW[dayOfWeek(day.date)]);
  } catch (e) { reportError(e); }
}

// Dragging a day onto another trades their meals.
var dragState = null;

function startDayDrag(ev, dayId) {
  ev.preventDefault();
  var card = ev.currentTarget.closest('.daycard');
  if (!card) return;
  dragState = { dayId: dayId, card: card };
  card.classList.add('lifted');

  function cards() {
    return Array.prototype.slice.call(document.querySelectorAll('.daycard[data-day-id]'));
  }
  function targetAt(y) {
    var list = cards();
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      var centre = r.top + r.height / 2;
      var d = Math.abs(y - centre);
      if (d < bestDist) { bestDist = d; best = list[i]; }
    }
    return best;
  }
  function paint(el) {
    var list = cards();
    for (var i = 0; i < list.length; i++) {
      list[i].classList.toggle('dropTarget', list[i] === el && list[i] !== card);
    }
  }
  function onMove(e) {
    paint(targetAt(e.clientY));
    // The plan can be taller than the screen, so nudge it along near the edges.
    if (e.clientY < 90) window.scrollBy(0, -9);
    else if (e.clientY > window.innerHeight - 150) window.scrollBy(0, 9);
  }
  function finish(e) {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    card.classList.remove('lifted');
    var list = cards();
    for (var i = 0; i < list.length; i++) list[i].classList.remove('dropTarget');
    dragState = null;
    if (!e || e.type === 'pointercancel') return;
    var target = targetAt(e.clientY);
    var targetId = target ? Number(target.getAttribute('data-day-id')) : 0;
    if (targetId && targetId !== dayId) swapDays(dayId, targetId);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  paint(null);
}

async function swapDays(fromId, toId) {
  try {
    var data = await api('POST', '/api/days/' + fromId + '/swap', { withDayId: toId });
    state.week = data;
    render();
    toast('Days traded');
  } catch (e) { reportError(e); }
}

function editorPanel(day) {
  var panel = h('div', { class: 'editor' });
  if (day.type === 'gourmet') panel.appendChild(gourmetSlot(day));
  else for (var i = 0; i < SLOT_ROLES.length; i++) panel.appendChild(itemSlot(day, SLOT_ROLES[i]));
  panel.appendChild(h('button', {
    class: 'primary wide', style: 'margin-top:12px', text: 'Done',
    onclick: function () { state.editingDay = null; render(); }
  }));
  return panel;
}

function gourmetSlot(day) {
  var wrap = h('div', { class: 'slot' });
  wrap.appendChild(h('label', { text: 'Gourmet title' }));
  wrap.appendChild(h('button', {
    class: 'slotbtn plain',
    text: day.gourmetTitle || '— not set —',
    onclick: function () { openGourmetPicker(day); }
  }));
  if (day.gourmetIngredients) wrap.appendChild(h('div', { class: 'ing', text: day.gourmetIngredients }));
  return wrap;
}

function openGourmetPicker(day) {
  var list = state.bootstrap.gourmet || [];
  var rows = [h('button', {
    class: 'pickrow plain',
    text: '— not set —',
    onclick: function () { closeModal(); swapGourmet(day.id, ''); }
  })];
  for (var i = 0; i < list.length; i++) {
    (function (g) {
      rows.push(h('button', {
        class: 'pickrow plain' + (day.gourmetId === g.id ? ' current' : ''),
        text: g.title,
        onclick: function () { closeModal(); swapGourmet(day.id, String(g.id)); }
      }));
    })(list[i]);
  }
  modalSheet(h('div', null,
    h('h2', { text: 'Gourmet for ' + DOW[dayOfWeek(day.date)] }),
    h('div', { class: 'picklist' }, rows)
  ));
}

// Native select elements cannot be coloured, so the picker is a real list.
// Marked items come first in green, unmarked follow in orange, with no group
// headings: the colour is the only label.
function itemSlot(day, role) {
  var cur = day.slots ? day.slots[role] : null;
  var all = itemsForRole(role);
  var current = null;
  for (var i = 0; i < all.length; i++) if (cur && all[i].id === cur.itemId) current = all[i];

  var wrap = h('div', { class: 'slot' });
  wrap.appendChild(h('label', { text: SLOT_LABEL[role] }));
  wrap.appendChild(h('button', {
    class: 'slotbtn ' + (current ? (current.selected ? 'marked' : 'unmarked') : 'plain'),
    text: current ? current.name : '— none —',
    onclick: function () { openItemPicker(day, role); }
  }));
  return wrap;
}

function openItemPicker(day, role) {
  var all = itemsForRole(role);
  var marked = [], unmarked = [];
  for (var i = 0; i < all.length; i++) (all[i].selected ? marked : unmarked).push(all[i]);
  var ordered = marked.concat(unmarked);
  var cur = day.slots ? day.slots[role] : null;

  var rows = [h('button', {
    class: 'pickrow plain',
    text: '— none —',
    onclick: function () { closeModal(); swapSlot(day.id, role, ''); }
  })];
  for (var j = 0; j < ordered.length; j++) {
    (function (it) {
      rows.push(h('button', {
        class: 'pickrow ' + (it.selected ? 'marked' : 'unmarked') + (cur && cur.itemId === it.id ? ' current' : ''),
        text: it.name,
        onclick: function () { closeModal(); swapSlot(day.id, role, String(it.id)); }
      }));
    })(ordered[j]);
  }
  if (!ordered.length) rows.push(h('p', { class: 'muted', text: 'Nothing available for this slot yet. Add items in the catalog.' }));

  modalSheet(h('div', null,
    h('h2', { text: 'Choose a ' + SLOT_LABEL[role].toLowerCase() }),
    h('div', { class: 'picklist' }, rows)
  ));
}

// ----------------------------------------------------------------- shop

// The week's own budget wins; otherwise the household default applies.
function effectiveBudget() {
  if (!state.week) return 0;
  var wk = state.week.week;
  if (wk.budget !== null && wk.budget !== undefined && wk.budget > 0) return wk.budget;
  var s = state.bootstrap.settings || {};
  return Number(s.default_budget || 0) || 0;
}

function isUsingDefaultBudget() {
  if (!state.week) return true;
  var wk = state.week.week;
  return !(wk.budget !== null && wk.budget !== undefined && wk.budget > 0);
}

function budgetSummary() {
  var eff = effectiveBudget();
  if (!eff) return 'Not set';
  return isUsingDefaultBudget() ? ('Default · ' + eff) : String(eff);
}

function budgetLine(totals) {
  var budget = effectiveBudget();
  if (!budget) return { text: 'No budget set', cls: 'sub' };
  var left = budget - totals.total;
  if (left >= 0) return { text: left + ' left of ' + budget, cls: 'under' };
  return { text: Math.abs(left) + ' over the ' + budget + ' budget', cls: 'over' };
}

function openBudgetPicker() {
  var s = state.bootstrap.settings || {};
  var def = Number(s.default_budget || 0) || 0;
  var usingDefault = isUsingDefaultBudget();
  var input = h('input', {
    class: 'price', type: 'text', inputmode: 'numeric', style: 'width:130px',
    value: usingDefault ? '' : String(state.week.week.budget),
    placeholder: def ? String(def) : '0'
  });
  modalSheet([
    h('h2', { text: 'Weekly budget' }),
    h('p', { class: 'muted', text: def > 0 ? 'Household default: ' + def : 'No household default yet. Set one in Settings.' }),
    h('label', { class: 'f', text: 'Budget for this week' }),
    input,
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', {
        class: 'primary', style: 'flex:1', text: 'Save',
        onclick: function () {
          var raw = input.value.replace(/[^0-9]/g, '');
          closeModal();
          saveBudget(raw === '' ? null : parseInt(raw, 10));
        }
      }),
      h('button', {
        text: 'Use default',
        onclick: function () { closeModal(); saveBudget(null); }
      })
    )
  ]);
}

function renderShop() {
  var wrap = h('div');
  if (!state.week || !state.week.planId) {
    wrap.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'No shopping list yet' }),
      h('p', { class: 'muted', text: 'Generate and save a week first. The list is the saved plan plus every Pantry item.' })
    ));
    return wrap;
  }

  var wk = state.week.week;
  var lines = state.week.shopping || [];
  var totals = state.week.totals || { total: 0, priced: 0, bought: 0, count: 0, remaining: 0 };
  var budget = budgetLine(totals);

  // The top is only for setting this week's budget. Every number lives in the
  // static bar at the bottom, so nothing is stated twice.
  var head = h('div', { class: 'card tight' },
    h('button', { class: 'budget-row', onclick: openBudgetPicker },
      h('span', { class: 'budget-label', text: 'Weekly budget' }),
      h('span', { class: 'budget-value', text: budgetSummary() }),
      h('span', { class: 'chev', text: '›' })
    )
  );
  if (wk.exportedAt) {
    // "the file" only ever told half the story once the hand-off could also be
    // a button: a downloaded CSV is frozen, but a re-send refreshes the
    // Sompitra expense in place, so later changes do land there.
    head.appendChild(h('div', { class: 'warn', style: 'margin-top:8px', text: 'Already exported on ' + wk.exportedAt + '. A file you already downloaded will not have later changes; re-sending to Sompitra updates that expense in place.' }));
  }

  // Pantry items are on every list and rarely change, so they are folded away
  // until asked for rather than padding out the list every week.
  var pantryCount = 0;
  for (var pc = 0; pc < lines.length; pc++) if (lines[pc].isPantry) pantryCount++;
  if (pantryCount) {
    head.appendChild(h('button', {
      class: 'wide pantryToggle',
      text: (state.showPantry ? 'Hide' : 'Show') + ' the ' + pantryCount + ' pantry items',
      onclick: function () { state.showPantry = !state.showPantry; render(); }
    }));
  }
  wrap.appendChild(head);

  if (!lines.length) {
    wrap.appendChild(h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Nothing to buy yet.' })));
    return wrap;
  }

  var shown = state.showPantry ? lines : lines.filter(function (l) { return !l.isPantry; });
  var groups = [], index = {};
  for (var i = 0; i < shown.length; i++) {
    var line = shown[i];
    if (!index[line.groupId]) {
      index[line.groupId] = { id: line.groupId, name: line.groupName, cls: typeClassById(line.groupId), lines: [] };
      groups.push(index[line.groupId]);
    }
    index[line.groupId].lines.push(line);
  }

  var card = h('div', { class: 'card flush' });
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var done = 0;
    for (var k = 0; k < grp.lines.length; k++) if (grp.lines[k].bought) done++;
    card.appendChild(h('div', { class: 'sec ' + grp.cls },
      h('h3', { text: grp.name }),
      h('span', { class: 'pill', text: done + '/' + grp.lines.length })
    ));
    for (var j = 0; j < grp.lines.length; j++) card.appendChild(shopLine(grp.lines[j], grp.cls));
  }
  wrap.appendChild(card);

  wrap.appendChild(h('div', { class: 'totals' },
    h('div', { class: 'tot' },
      h('div', { class: 'big', id: 'sticky-total', text: String(totals.total) }),
      h('div', { class: 'sub' },
        h('span', { id: 'sticky-budget', class: budget.cls, text: budget.text }),
        h('span', { text: ' · ' }),
        h('span', { id: 'sticky-count', text: totals.bought + '/' + totals.count + ' in the bag' })
      )
    ),
    h('button', { class: 'btn-export', onclick: openExportPreview },
      h('span', { class: 'ico', text: '📤' }),
      h('span', { text: 'Export' })
    )
  ));
  return wrap;
}

function shopLine(line, cls) {
  var row = h('div', { class: 'shopline ' + roleClass(line.slotRole) + (line.bought ? ' bought' : ''), id: 'line-' + line.id });

  row.appendChild(h('div', { class: 'nm' },
    h('span', { text: line.name }),
    line.count > 1 ? h('span', { class: 'qty', text: 'x' + line.count }) : null
  ));

  var input = h('input', {
    class: 'price', type: 'text', inputmode: 'numeric',
    value: line.price ? String(line.price) : '', placeholder: '0'
  });
  var timer = null;
  var lastSent = line.price === null || line.price === undefined ? null : line.price;
  function flush() {
    var raw = input.value.replace(/[^0-9]/g, '');
    input.value = raw;
    var price = raw === '' ? null : parseInt(raw, 10);
    if (price === 0) price = null;
    // Compared against what was last sent, not against the value this row was
    // rendered with, or the blur flush repeats the debounced save.
    if (price === lastSent) return;
    lastSent = price;
    api('PATCH', '/api/lines/' + line.id, { price: price }).then(applyState).catch(reportError);
  }
  input.addEventListener('input', function () {
    input.value = input.value.replace(/[^0-9]/g, '');
    var value = parseInt(input.value, 10);
    row.className = 'shopline ' + roleClass(line.slotRole) + (value > 0 ? ' bought' : '');
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(); }, 600);
  });
  input.addEventListener('blur', function () {
    if (timer) { clearTimeout(timer); timer = null; }
    flush();
  });
  row.appendChild(input);
  return row;
}

// Recomputes the running totals in place so a field being typed into keeps its
// focus and caret.
function updateTotalsOnly() {
  if (!state.week) return;
  var lines = state.week.shopping || [];
  var total = 0, priced = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].price > 0) { total += lines[i].price; priced++; }
  }
  var bought = priced;
  var totals = {
    total: total, priced: priced, bought: bought, count: lines.length,
    remaining: lines.length - bought, unpricedBought: 0
  };
  state.week.totals = totals;
  var budget = budgetLine(totals);
  setText('sticky-total', String(total));
  setText('sticky-count', bought + '/' + lines.length + ' in the bag');
  var sEl = document.getElementById('sticky-budget');
  if (sEl) { sEl.textContent = budget.text; sEl.className = budget.cls; }
}

function setText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

// --------------------------------------------------- Sompitra hand-off
//
// The old way to get this shopping list into the budget was: Export preview →
// Download CSV → open Sompitra → add an itemized expense → "Import CSV" → pick
// the file. Four steps and a file, for numbers both apps already hold.
//
// Sompitra's endpoint, not ours, so it does not go through api() — that one
// prefixes /laoka. The week id IS the identity of the expense on Sompitra's
// side (it keeps a ledger keyed by week), so pressing send twice UPDATEs the
// same expense instead of adding a second one. That is why the button can
// safely say "send again", and why the state line below is worth showing.
function sompitraFetch(method, path, body) {
  var opts = { method: method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (data) {
      if (!data) {
        // A redirect here means the Home session is gone; Sompitra answers the
        // login page instead of JSON, and nothing in this frame can sign in.
        if (res.redirected) window.top.location.href = '/login';
        throw new Error('Sompitra did not answer (' + res.status + ')');
      }
      if (!res.ok || data.ok === false) throw new Error(data.error || ('request failed (' + res.status + ')'));
      return data;
    });
  });
}

function moneyAmount(n) { return 'Ar ' + Number(n || 0).toLocaleString('en-US'); }

// Ledger timestamps arrive as ISO ("2026-09-18T09:12:00.846Z") and Laoka's own
// as SQLite ("2026-09-18 09:12:00"). Show both as one readable form.
function stampShort(s) { return String(s || '').replace('T', ' ').replace('Z', '').slice(0, 16); }

function openSompitraTransactions() { window.top.location.href = '/budget/transactions'; }

// The confirmation after a send. Worth its own sheet: the numbers just left
// this app, so the reply has to say what Sompitra did with them.
function sompitraResultSheet(r) {
  var nodes = [h('h2', { text: r.action === 'updated' ? 'Sompitra expense updated' : 'Sent to Sompitra' })];
  nodes.push(h('p', { text: r.description || '' }));
  nodes.push(h('p', { class: 'muted', text: r.itemCount + ' items, ' + moneyAmount(r.amount) + ', as one itemized expense dated today.' }));
  nodes.push(h('div', { class: 'row', style: 'margin-top:14px' },
    h('button', { class: 'primary', style: 'flex:1', text: '↗ Open in Sompitra', onclick: openSompitraTransactions }),
    h('button', { text: 'Done', onclick: closeModal })
  ));
  modalSheet(nodes);
}

function sendToSompitra(weekId, btn) {
  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  sompitraFetch('POST', '/budget/import-laoka', { week: weekId }).then(function (r) {
    closeModal();
    toast((r.action === 'updated' ? 'Sompitra expense updated — ' : 'Sent to Sompitra — ') +
      r.itemCount + ' items, ' + moneyAmount(r.amount));
    softRefresh();
    sompitraResultSheet(r);
  }).catch(function (e) {
    btn.disabled = false;
    btn.textContent = label;
    reportError(e);
  });
}

function paintSompitraActions(actions, wk, note) {
  clear(actions);
  var sent = note && note.sent;
  var btn = h('button', { class: 'primary wide', text: sent ? '🔄 Send again (updates that expense)' : '📤 Send to Sompitra' });
  btn.onclick = function () { sendToSompitra(wk.id, btn); };
  actions.appendChild(btn);
  if (sent) {
    actions.appendChild(h('p', { class: 'note', text: 'In Sompitra already: ' + note.itemCount + ' items, ' + moneyAmount(note.amount) +
      ' · ' + (note.updatedAt ? 'updated ' : 'sent ') + stampShort(note.updatedAt || note.importedAt) +
      '. Sending again refreshes those numbers in place — it never adds a second expense.' }));
    var openBtn = h('button', { class: 'wide', text: '↗ Open in Sompitra' });
    openBtn.onclick = openSompitraTransactions;
    actions.appendChild(openBtn);
  } else if (note && note.stale) {
    actions.appendChild(h('p', { class: 'note', text: 'The expense this week was sent to no longer exists in Sompitra, so this creates a fresh one.' }));
  }
}

function loadSompitraActions(actions, wk) {
  sompitraFetch('GET', '/budget/laoka-import?week=' + encodeURIComponent(wk.id)).then(function (note) {
    paintSompitraActions(actions, wk, note);
  }).catch(function (e) {
    // Could not read the state — still offer the send, because it is safe by
    // construction: the week id keys the ledger, so a blind send cannot
    // duplicate. Say so rather than hiding the button.
    clear(actions);
    var btn = h('button', { class: 'primary wide', text: '📤 Send to Sompitra' });
    btn.onclick = function () { sendToSompitra(wk.id, btn); };
    actions.appendChild(btn);
    actions.appendChild(h('p', { class: 'note', text: 'Could not ask Sompitra whether this week was sent (' + (e && e.message ? e.message : 'no answer') + '). Sending is still safe: the week id is the key, so it updates rather than duplicates.' }));
  });
}

function openExportPreview() {
  var lines = (state.week.shopping || []).filter(function (l) { return l.price > 0; });
  var wk = state.week.week;
  var total = 0;
  for (var i = 0; i < lines.length; i++) total += lines[i].price;
  var sorted = lines.slice().sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });

  var nodes = [h('h2', { text: 'Export preview' }), h('p', { class: 'muted', text: wk.exportName || '' })];
  if (wk.exportedAt) nodes.push(h('div', { class: 'warn', style: 'margin:8px 0', text: 'Already exported on ' + wk.exportedAt + '. This download is regenerated from the current list.' }));

  if (!lines.length) {
    nodes.push(h('p', { text: 'Nothing is priced yet, so there is nothing to export.' }));
    nodes.push(h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'wide', text: 'Close', onclick: closeModal })));
    modalSheet(nodes);
    return;
  }

  nodes.push(h('p', { class: 'muted', text: lines.length + ' lines, total ' + total + '. Sorted A to Z, no currency.' }));
  var table = h('table', { class: 'preview-table' }, h('tr', null, h('th', { text: 'Item' }), h('th', { text: 'Price' })));
  for (var j = 0; j < sorted.length; j++) table.appendChild(h('tr', null, h('td', { text: sorted[j].name }), h('td', { text: String(sorted[j].price) })));
  nodes.push(h('div', { style: 'max-height:38vh; overflow:auto' }, table));

  // Straight into the budget as ONE itemized expense. The CSV download stays
  // for anyone who wants the file, but it is no longer the only way across.
  var actions = h('div', { class: 'row', style: 'margin-top:14px; flex-direction:column; align-items:stretch' },
    h('button', { class: 'primary wide', disabled: true, text: 'Checking Sompitra…' }));
  nodes.push(actions);
  nodes.push(h('div', { class: 'row', style: 'margin-top:8px' },
    h('button', {
      style: 'flex:1', text: 'Download CSV',
      onclick: function () {
        window.location.href = '/laoka/api/weeks/' + wk.id + '/export';
        closeModal();
        setTimeout(softRefresh, 1500);
      }
    }),
    h('button', { text: 'Cancel', onclick: closeModal })
  ));
  modalSheet(nodes);
  loadSompitraActions(actions, wk);
}

// -------------------------------------------------------------- catalog

function renderCatalog() {
  var wrap = h('div');
  var counts = poolCounts();
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' },
        h('h2', { style: 'margin:0', text: 'Ingredients' }),
        h('p', { class: 'note', style: 'margin-top:2px', text: counts.protein + ' proteins, ' + counts.side + ' sides and ' + counts.salad + ' salads available to draw from.' })
      ),
      h('button', { class: 'primary', text: '➕ Add', onclick: openAddItem })
    ),
    h('p', { class: 'note', text: 'Everything listed is available. Mark ❌ on anything you would not buy this week and generation will leave it out; the mark carries forward to later weeks.' })
  ));
  var groups = catalogGroups();
  for (var i = 0; i < groups.length; i++) wrap.appendChild(groupNode(groups[i]));
  return wrap;
}

var SLOT_CHOICES = [
  ['protein', 'protein slot'],
  ['side', 'side slot'],
  ['salad', 'salad slot'],
  ['none', 'no slot (pantry)']
];

// Default the slot from the level 1 type, which is right for every case except
// a second salad group.
function defaultRole(groupName) {
  var n = String(groupName || '').toLowerCase();
  if (n.indexOf('protein') !== -1) return 'protein';
  if (n.indexOf('side') !== -1) return 'side';
  return 'none';
}

function groupManagers() {
  var card = h('div');

  // ---- level 1
  var m1 = h('div', { class: 'mgr' });
  m1.appendChild(h('h4', { text: 'Add a type' }));
  var name1 = h('input', { type: 'text', placeholder: 'e.g. Drinks', autocomplete: 'off' });
  var pantry1 = h('select', {},
    h('option', { value: '0', text: 'Normal group' }),
    h('option', { value: '1', text: 'Pantry · always on the shopping list' })
  );
  m1.appendChild(name1);
  m1.appendChild(h('div', { class: 'row', style: 'margin-top:8px' },
    h('span', { style: 'flex:1' }, pantry1),
    h('button', {
      class: 'primary', text: 'Add',
      onclick: async function () {
        var name = name1.value.trim();
        if (!name) { toast('Give the type a name', true); name1.focus(); return; }
        try {
          await api('POST', '/api/groups', { name: name, isPantry: pantry1.value === '1' });
          await refreshBootstrap();
          render();
          toast('Added ' + name);
        } catch (e) { reportError(e); }
      }
    })
  ));
  card.appendChild(m1);

  // ---- level 2
  var m2 = h('div', { class: 'mgr' });
  m2.appendChild(h('h4', { text: 'Add a group' }));
  var name2 = h('input', { type: 'text', placeholder: 'e.g. lamb', autocomplete: 'off' });
  var icon2 = h('input', { type: 'text', class: 'iconinput', placeholder: '🐑', maxlength: '4', autocomplete: 'off', 'aria-label': 'Icon' });
  var swatch = h('span', { class: 'swatch' });
  var parent2 = h('select', { onchange: function () { paint(); role2.value = defaultRole(this.options[this.selectedIndex].text); } });
  for (var i = 0; i < catalogGroups().length; i++) {
    parent2.appendChild(h('option', { value: String(catalogGroups()[i].id), text: catalogGroups()[i].name }));
  }
  var role2 = h('select', {});
  for (var r = 0; r < SLOT_CHOICES.length; r++) role2.appendChild(h('option', { value: SLOT_CHOICES[r][0], text: SLOT_CHOICES[r][1] }));
  function paint() { swatch.className = 'swatch ' + typeClassById(Number(parent2.value)); }
  paint();
  role2.value = defaultRole(parent2.options[0] ? parent2.options[0].text : '');

  m2.appendChild(h('label', { class: 'f', text: 'Group name and icon' }));
  m2.appendChild(h('div', { class: 'row' }, icon2, h('span', { style: 'flex:1' }, name2)));
  m2.appendChild(h('div', { class: 'row', style: 'margin-top:8px' }, swatch, h('span', { style: 'flex:1' }, parent2)));
  m2.appendChild(h('label', { class: 'f', text: 'Slot it fills' }), role2);
  m2.appendChild(h('button', {
    class: 'primary wide', style: 'margin-top:10px', text: 'Add group',
    onclick: async function () {
      var name = name2.value.trim();
      if (!name) { toast('Give the group a name', true); name2.focus(); return; }
      try {
        await api('POST', '/api/subgroups', {
          groupId: Number(parent2.value),
          name: name,
          slotRole: role2.value,
          icon: icon2.value.trim()
        });
        await refreshBootstrap();
        render();
        toast('Added ' + name);
      } catch (e) { reportError(e); }
    }
  }));
  m2.appendChild(h('p', { class: 'note', text: 'The swatch shows the colour that type uses, which follows through to the shopping list.' }));
  card.appendChild(m2);

  return card;
}

function unusedCatalogAddPanel() {
  var NEW = '__new__';
  var panel = h('div');
  var nameInput = h('input', { type: 'text', placeholder: 'Item name, e.g. chicken thighs', autocomplete: 'off' });

  var subSelect = h('select', { onchange: function () { newWrap.className = this.value === NEW ? '' : 'hidden'; } });
  for (var i = 0; i < catalogGroups().length; i++) {
    var g = catalogGroups()[i];
    for (var j = 0; j < g.subgroups.length; j++) {
      subSelect.appendChild(h('option', { value: String(g.subgroups[j].id), text: g.name + ' › ' + g.subgroups[j].name }));
    }
  }
  subSelect.appendChild(h('option', { value: NEW, text: '＋ Add new group…' }));

  var newGroupName = h('input', { type: 'text', placeholder: 'New group name, e.g. lamb', autocomplete: 'off' });
  var groupSelect = h('select', {});
  for (var k = 0; k < catalogGroups().length; k++) {
    groupSelect.appendChild(h('option', { value: String(catalogGroups()[k].id), text: catalogGroups()[k].name }));
  }
  var roleSelect = h('select', {});
  var roles = [['protein', 'protein slot'], ['side', 'side slot'], ['salad', 'salad slot'], ['none', 'no slot (pantry)']];
  for (var r = 0; r < roles.length; r++) roleSelect.appendChild(h('option', { value: roles[r][0], text: roles[r][1] }));

  // The slot role follows the main group by default, which is right for every
  // case except a second salad group.
  groupSelect.addEventListener('change', function () {
    var name = (groupSelect.options[groupSelect.selectedIndex].text || '').toLowerCase();
    roleSelect.value = name.indexOf('protein') !== -1 ? 'protein' : (name.indexOf('side') !== -1 ? 'side' : 'none');
  });

  var newWrap = h('div', { class: 'hidden' },
    h('label', { class: 'f', text: 'New group name' }), newGroupName,
    h('label', { class: 'f', text: 'Main group' }), groupSelect,
    h('label', { class: 'f', text: 'Slot' }), roleSelect
  );

  panel.appendChild(h('label', { class: 'f', text: 'Item name' }));
  panel.appendChild(nameInput);
  panel.appendChild(h('label', { class: 'f', text: 'Group' }));
  panel.appendChild(subSelect);
  panel.appendChild(newWrap);
  panel.appendChild(h('button', {
    class: 'primary wide big', style: 'margin-top:14px', text: 'Add',
    onclick: async function () {
      var name = nameInput.value.trim();
      if (!name) { toast('Give the item a name', true); nameInput.focus(); return; }
      try {
        var subId = subSelect.value;
        if (subId === NEW) {
          var gname = newGroupName.value.trim();
          if (!gname) { toast('Give the new group a name', true); newGroupName.focus(); return; }
          var made = await api('POST', '/api/subgroups', { groupId: Number(groupSelect.value), name: gname, slotRole: roleSelect.value });
          subId = made.id;
        }
        await api('POST', '/api/items', { subgroupId: Number(subId), name: name });
        await refreshBootstrap();
        nameInput.value = '';
        render();
        toast('Added ' + name);
      } catch (e) { reportError(e); }
    }
  }));
  return panel;
}

function groupNode(group) {
  var cls = typeClassById(group.id);
  var node = h('div', { class: 'node ' + cls });
  node.appendChild(h('header', null,
    h('span', { class: 'type-name', text: group.name }),
    group.isPantry ? h('span', { class: 'role-tag', text: 'pantry' }) : null,
    h('span', { class: 'head-actions' },
      h('button', { class: 'icon', text: '✏️', title: 'Edit group', onclick: function () { editGroup(group); } }),
      h('button', { class: 'icon', text: '🗑️', title: 'Delete group', onclick: function () { deleteGroup(group); } })
    )
  ));
  var list = h('div', { class: 'sublist' });
  if (!group.subgroups.length) list.appendChild(h('p', { class: 'muted small', text: 'No groups inside yet.' }));
  for (var i = 0; i < group.subgroups.length; i++) list.appendChild(subgroupNode(group, group.subgroups[i]));
  node.appendChild(list);
  return node;
}

function subgroupNode(group, sub) {
  var node = h('div', { class: 'sub' });
  node.appendChild(h('header', null,
    h('strong', { text: withIcon(sub) }),
    h('span', { class: 'role-tag', text: sub.slotRole === 'none' ? 'no slot' : sub.slotRole }),
    h('button', { class: 'icon', text: '✏️', title: 'Edit group', onclick: function () { editSubgroup(group, sub); } }),
    h('button', { class: 'icon', text: '🗑️', title: 'Delete group', onclick: function () { deleteSubgroup(sub); } })
  ));
  var pills = h('div', { class: 'pills' });
  for (var i = 0; i < sub.items.length; i++) pills.appendChild(itemPill(sub.items[i]));
  if (!sub.items.length) pills.appendChild(h('span', { class: 'muted small', text: 'No items yet.' }));
  node.appendChild(pills);

  return node;
}

// One entry point for adding an item: pick the group, then name it. The swatch
// shows which type that group belongs to, and groups are listed under their
// type in the dropdown.
function openAddItem() {
  var groups = catalogGroups();
  var select = h('select', {});
  for (var i = 0; i < groups.length; i++) {
    var subs = groups[i].subgroups;
    if (!subs.length) continue;
    var og = h('optgroup', { label: groups[i].name });
    for (var j = 0; j < subs.length; j++) {
      og.appendChild(h('option', {
        value: String(subs[j].id),
        text: subs[j].name,
        'data-group': String(groups[i].id)
      }));
    }
    select.appendChild(og);
  }
  if (!select.options.length) {
    modalSheet([
      h('h2', { text: 'Add an item' }),
      h('p', { class: 'muted', text: 'There are no groups yet. Add a type and a group in Settings first.' }),
      h('button', { class: 'wide', style: 'margin-top:14px', text: 'Close', onclick: closeModal })
    ]);
    return;
  }

  var swatch = h('span', { class: 'swatch' });
  function paint() {
    var opt = select.options[select.selectedIndex];
    swatch.className = 'swatch ' + typeClassById(opt ? Number(opt.getAttribute('data-group')) : 0);
  }
  select.addEventListener('change', paint);
  paint();

  var name = h('input', { type: 'text', placeholder: 'e.g. chicken thighs', autocomplete: 'off' });
  async function submit() {
    var value = name.value.trim();
    if (!value) { toast('Give the item a name', true); name.focus(); return; }
    try {
      await api('POST', '/api/items', { subgroupId: Number(select.value), name: value });
      closeModal();
      await refreshBootstrap();
      render();
      toast('Added ' + value);
    } catch (e) { reportError(e); }
  }
  name.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

  modalSheet([
    h('h2', { text: 'Add an item' }),
    h('label', { class: 'f', text: 'Item name' }), name,
    h('label', { class: 'f', text: 'Group' }),
    h('div', { class: 'row' }, swatch, h('span', { style: 'flex:1' }, select)),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { class: 'primary', style: 'flex:1', text: 'Add', onclick: submit }),
      h('button', { text: 'Cancel', onclick: closeModal })
    )
  ]);
  setTimeout(function () { name.focus(); }, 40);
}

// Available is the norm, so the control marks the exception: a cross means
// this one is unavailable, and tapping it again puts it back.
function itemPill(item) {
  return h('div', { class: 'pill-item' + (item.selected ? ' on' : ' off') },
    h('button', {
      class: 'availbtn' + (item.selected ? '' : ' out'),
      title: item.selected ? 'Available. Tap to mark it unavailable.' : 'Unavailable. Tap to make it available again.',
      text: item.selected ? '✓' : '❌',
      onclick: function () { toggleItem(item, !item.selected); }
    }),
    h('span', { class: 'nm', text: item.name }),
    h('button', { class: 'icon', text: '✏️', title: 'Edit item', onclick: function () { editItem(item); } }),
    h('button', { class: 'icon', text: '🗑️', title: 'Delete item', onclick: function () { deleteItem(item); } })
  );
}

// -------------------------------------------------------------- gourmet

function renderGourmet() {
  var wrap = h('div');
  var list = state.bootstrap.gourmet || [];
  wrap.appendChild(h('div', { class: 'card' },
    h('h2', { text: 'Gourmet' }),
    h('p', { class: 'note', text: 'Sunday only. The ingredients are reference notes: they never reach the shopping list or the CSV.' }),
    h('button', { class: 'primary wide big', style: 'margin-top:10px', text: 'Add a recipe', onclick: function () { editGourmet(null); } })
  ));

  var card = h('div', { class: 'card flush' });
  if (!list.length) card.appendChild(h('p', { class: 'muted', style: 'padding:12px', text: 'No recipes yet.' }));
  for (var i = 0; i < list.length; i++) {
    (function (g) {
      var box = h('div', { class: 'recipe' });
      var head = h('div', { class: 'head' });
      if (g.hasImage) head.appendChild(h('img', { class: 'photo', src: imageUrl(g.id, g.imageUpdatedAt), alt: '' }));
      head.appendChild(h('strong', { text: g.title }));
      head.appendChild(h('button', { class: 'tiny', text: 'View', onclick: function () { viewRecipe(g); } }));
      head.appendChild(h('button', { class: 'icon', text: '✏️', title: 'Edit', onclick: function () { editGourmet(g); } }));
      head.appendChild(h('button', { class: 'icon', text: '🗑️', title: 'Delete', onclick: function () { deleteGourmet(g); } }));
      box.appendChild(head);
      card.appendChild(box);
    })(list[i]);
  }
  wrap.appendChild(card);
  return wrap;
}

// The list stays collapsed to titles; this is where a recipe is actually read.
function viewRecipe(g) {
  var nodes = [h('h2', { text: g.title })];
  if (g.hasImage) nodes.push(h('img', { class: 'photo-lg', src: imageUrl(g.id, g.imageUpdatedAt), alt: '' }));
  if (g.link) nodes.push(h('a', { class: 'link', href: g.link, target: '_blank', rel: 'noopener noreferrer', text: g.link, style: 'margin-top:10px' }));
  nodes.push(g.ingredients
    ? h('div', { class: 'ing', text: g.ingredients })
    : h('p', { class: 'muted', text: 'No ingredients recorded for this one.' }));
  nodes.push(h('div', { class: 'row', style: 'margin-top:14px' },
    h('button', { class: 'primary', style: 'flex:1', text: 'Edit', onclick: function () { closeModal(); editGourmet(g); } }),
    h('button', { text: 'Close', onclick: closeModal })
  ));
  modalSheet(nodes);
}

async function editGourmet(g) {
  var values = await formModal(g ? 'Edit recipe' : 'New recipe', [
    { name: 'title', label: 'Title', value: g ? g.title : '', placeholder: 'Sunday roast', required: true },
    { name: 'link', label: 'Link (optional)', value: g && g.link ? g.link : '', placeholder: 'https://…' },
    {
      name: 'photo', label: 'Picture (optional)', type: 'image',
      value: g && g.hasImage ? imageUrl(g.id, g.imageUpdatedAt) : '',
      hint: 'Resized in the browser before it is stored, so a phone photo costs a few hundred kilobytes.'
    },
    { name: 'ingredients', label: 'Ingredients', type: 'textarea', rows: 12, value: g && g.ingredients ? g.ingredients : '', placeholder: 'Paste or type the ingredients. No limit.' }
  ], g ? 'Save' : 'Add');
  if (!values) return;

  var payload = { title: values.title, link: values.link, ingredients: values.ingredients };
  if (pendingImage.image !== undefined) {
    payload.image = pendingImage.image;
    payload.imageType = pendingImage.imageType;
  }
  try {
    if (g) await api('PATCH', '/api/gourmet/' + g.id, payload);
    else await api('POST', '/api/gourmet', payload);
    await refreshBootstrap();
    render();
    toast(g ? 'Recipe updated' : 'Recipe added');
  } catch (e) { reportError(e); }
}

async function deleteGourmet(g) {
  var ok = await confirmAction('Delete ' + g.title + '?', 'It stops being offered for new Sundays. Past weeks keep the title they used.', 'Delete');
  if (!ok) return;
  try { await api('DELETE', '/api/gourmet/' + g.id); await refreshBootstrap(); render(); } catch (e) { reportError(e); }
}

// -------------------------------------------------------------- history

function renderHistory() {
  var wrap = h('div');
  if (state.historyDetail) {
    var d = state.historyDetail;
    var card = h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('button', { text: '← Back', onclick: function () { state.historyDetail = null; render(); } }),
        h('span', { class: 'spacer' }),
        h('button', { text: 'Export', onclick: function () { window.location.href = '/laoka/api/history/' + d.week.id + '/export'; } }),
        h('button', { class: 'icon', text: '🗑️', title: 'Delete this archived week', onclick: function () { deleteHistory({ id: d.week.id, startDate: d.week.start_date, endDate: d.week.end_date }); } })
      ),
      h('h2', { style: 'margin-top:10px', text: shortDate(d.week.start_date) + ' to ' + shortDate(d.week.end_date) })
    );
    var days = d.days || [];
    for (var i = 0; i < days.length; i++) {
      var day = days[i];
      var items = (d.lines || []).filter(function (l) { return l.day_date === day.day_date; });
      var desc = day.day_type === 'gourmet'
        ? '🍽 ' + (day.gourmet_title || 'Gourmet')
        : items.map(function (l) { return l.item_name; }).join(' - ');
      card.appendChild(h('div', { class: 'row', style: 'padding:4px 0' },
        h('strong', { class: 'small', style: 'flex:0 0 46px', text: DOW3[dayOfWeek(day.day_date)] }),
        h('span', { class: 'small', style: 'flex:1', text: desc })
      ));
    }
    wrap.appendChild(card);
    return wrap;
  }

  wrap.appendChild(h('div', { class: 'card' },
    h('h2', { text: 'History' }),
    h('p', { class: 'note', text: 'Archived weeks keep their own item names and prices, so catalog changes never rewrite them.' })
  ));

  var months = state.history ? state.history.months : null;
  if (!months) { wrap.appendChild(h('p', { class: 'muted', text: 'Loading…' })); return wrap; }
  if (!months.length) { wrap.appendChild(h('div', { class: 'card' }, h('p', { class: 'muted', text: 'No archived weeks yet.' }))); return wrap; }

  for (var m = 0; m < months.length; m++) {
    var month = months[m];
    var total = 0;
    for (var w = 0; w < month.weeks.length; w++) total += month.weeks[w].total || 0;
    var det = h('details', { class: 'card flush' });
    det.appendChild(h('summary', null, month.month + '  ·  ' + month.weeks.length + ' weeks  ·  ' + total));
    for (var k = 0; k < month.weeks.length; k++) {
      (function (wk) {
        det.appendChild(h('div', { class: 'shopline', style: 'background:#fff' },
          h('div', { class: 'nm' },
            h('span', { text: shortDate(wk.startDate) + ' to ' + shortDate(wk.endDate) }),
            h('span', { class: 'qty', text: wk.lineCount + ' lines · ' + wk.total })
          ),
          h('button', { class: 'tiny', text: 'Open', onclick: function () { openHistory(wk.id); } }),
          h('button', { class: 'icon', text: '🗑️', title: 'Delete this archived week', onclick: function () { deleteHistory(wk); } })
        ));
      })(month.weeks[k]);
    }
    wrap.appendChild(det);
  }
  return wrap;
}

async function loadHistory() {
  if (state.historyLoading) return;
  state.historyLoading = true;
  try {
    state.history = await api('GET', '/api/history');
    if (state.tab === 'history') render();
  } catch (e) { reportError(e); }
  finally { state.historyLoading = false; }
}

// Removing the snapshot also frees its week, so the date can be planned again.
async function deleteHistory(wk) {
  var ok = await confirmAction(
    'Delete the week of ' + shortDate(wk.startDate) + '?',
    'The archived snapshot and its week are both removed, and the date becomes free to plan again. This cannot be undone.',
    'Delete'
  );
  if (!ok) return;
  try {
    await api('DELETE', '/api/history/' + wk.id);
    state.history = null;
    state.historyDetail = null;
    await refreshBootstrap();
    render();
    toast('That week is free to plan again');
  } catch (e) { reportError(e); }
}

async function openHistory(id) {
  try { state.historyDetail = await api('GET', '/api/history/' + id); render(); } catch (e) { reportError(e); }
}

// ------------------------------------------------------------- settings

// Settings is a list of collapsed rows. Nothing expands until it is tapped.
function settingsSection(title, valueText, bodyNodes, startOpen) {
  var row = h('details', { class: 'card flush setrow' });
  if (startOpen) row.setAttribute('open', 'open');
  row.appendChild(h('summary', null,
    h('span', { class: 'setlabel', text: title }),
    valueText ? h('span', { class: 'setval', text: valueText }) : null,
    h('span', { class: 'chev', text: '›' })
  ));
  row.appendChild(h('div', { class: 'setbody' }, bodyNodes));
  return row;
}

function renderSettings() {
  var wrap = h('div');
  var s = state.bootstrap.settings || {};
  var user = state.bootstrap.user;

  var budget = h('input', { class: 'price', type: 'text', inputmode: 'numeric', value: s.default_budget || '', placeholder: '0' });
  wrap.appendChild(settingsSection('Default weekly budget', s.default_budget ? String(s.default_budget) : 'Not set', [
    h('p', { class: 'note', style: 'margin-top:0', text: 'A new week starts from this budget unless you set one for that week on the shopping list.' }),
    h('label', { class: 'f', text: 'Amount' }),
    budget,
    h('button', {
      class: 'primary wide', style: 'margin-top:12px', text: 'Save',
      onclick: function () { saveSettings({ default_budget: budget.value.replace(/[^0-9]/g, '') }); }
    })
  ]));

  var maxWeeks = h('select', {});
  for (var j = 1; j <= 4; j++) maxWeeks.appendChild(h('option', { value: String(j), text: String(j), selected: String(s.max_active_weeks || '2') === String(j) }));
  wrap.appendChild(settingsSection('Weeks open at once', s.max_active_weeks || '2', [
    h('p', { class: 'note', style: 'margin-top:0', text: 'How many weeks can be planned at the same time.' }),
    maxWeeks,
    h('button', {
      class: 'primary wide', style: 'margin-top:12px', text: 'Save',
      onclick: function () { saveSettings({ max_active_weeks: maxWeeks.value }); }
    })
  ]));

  wrap.appendChild(settingsSection('Types and groups', catalogGroups().length + ' types', [groupManagers()]));

  if (user && user.role === 'admin') {
    var people = h('div');
    people.appendChild(h('button', { class: 'primary wide', text: 'Generate an invite code', onclick: generateInvite }));
    people.appendChild(h('p', { class: 'note', text: 'Read the code out to whoever is joining. They use it once, with a name and password of their own.' }));

    var invites = state.invites || [];
    for (var i = 0; i < invites.length; i++) {
      (function (inv) {
        people.appendChild(h('div', { class: 'plainrow' },
          h('div', { class: 'nm' },
            h('strong', { text: inv.code }),
            h('span', { class: 'qty', text: 'expires ' + inv.expires_at })
          ),
          h('button', { class: 'icon', text: '🗑️', title: 'Revoke this code', onclick: function () { revokeInvite(inv); } })
        ));
      })(invites[i]);
    }

    var users = state.users || [];
    for (var k = 0; k < users.length; k++) {
      (function (u) {
        people.appendChild(h('div', { class: 'plainrow' },
          h('div', { class: 'nm' },
            h('strong', { text: u.username }),
            h('span', { class: 'qty', text: u.role + (u.last_login_at ? ' · last in ' + u.last_login_at : ' · never signed in') })
          ),
          u.id === user.id ? null : h('button', { class: 'icon', text: '🗑️', title: 'Remove this person', onclick: function () { removeUser(u); } })
        ));
      })(users[k]);
    }
    loadUsers();
    loadInvites();
    wrap.appendChild(settingsSection('People', (state.users || []).length + ' accounts', [people]));
  }

  var cur = h('input', { type: 'password', placeholder: 'current password', autocomplete: 'current-password' });
  var next = h('input', { type: 'password', placeholder: 'new password, 8 or more', autocomplete: 'new-password' });
  wrap.appendChild(settingsSection('Your account', user ? user.username : '', [
    h('p', { class: 'note', style: 'margin-top:0', text: 'Signed in as ' + (user ? user.username : '') + ' (' + (user ? user.role : '') + ').' }),
    h('label', { class: 'f', text: 'Change password' }),
    cur,
    h('div', { style: 'height:8px' }),
    next,
    h('button', {
      class: 'primary wide', style: 'margin-top:12px', text: 'Change password',
      onclick: function () { changePassword(cur, next); }
    }),
    h('button', { class: 'wide', style: 'margin-top:8px', text: 'Sign out', onclick: signOut })
  ]));

  return wrap;
}

async function loadUsers() {
  if (state.users) return;
  try {
    var data = await api('GET', '/api/users');
    state.users = data.users || [];
    if (state.tab === 'settings') render();
  } catch (e) { /* admin only */ }
}

async function loadInvites() {
  if (state.invites) return;
  try {
    var data = await api('GET', '/api/invites');
    state.invites = data.invites || [];
    if (state.tab === 'settings') render();
  } catch (e) { /* admin only */ }
}

async function generateInvite() {
  try {
    var data = await api('POST', '/api/invites', {});
    modalSheet([
      h('h2', { text: 'Invite code' }),
      h('div', { class: 'invitecode', text: data.code }),
      h('p', { class: 'muted', style: 'text-align:center', text: 'Valid for ' + data.hours + ' hours, and works once.' }),
      h('button', { class: 'primary wide', style: 'margin-top:14px', text: 'Done', onclick: closeModal })
    ]);
    state.invites = null;
    render();
  } catch (e) { reportError(e); }
}

async function revokeInvite(inv) {
  var ok = await confirmAction('Revoke ' + inv.code + '?', 'Nobody will be able to use that code.', 'Revoke');
  if (!ok) return;
  try { await api('DELETE', '/api/invites/' + inv.id); state.invites = null; render(); } catch (e) { reportError(e); }
}

async function signOut() {
  // End the whole Home session (all modules), not just Laoka's cookie.
  try { await api('POST', '/api/auth/logout', {}); } catch (e) {}
  window.location.href = '/logout';
}

async function changePassword(current, next) {
  if (!next.value) { toast('Enter a new password', true); return; }
  try {
    await api('POST', '/api/auth/password', { current: current.value, next: next.value });
    current.value = '';
    next.value = '';
    toast('Password changed');
  } catch (e) { reportError(e); }
}

// -------------------------------------------------------------- actions

async function startWeek() {
  try {
    var data = await api('POST', '/api/weeks', {
      startDate: state.bootstrap.nextWeekStart || state.bootstrap.currentWeekStart
    });
    await refreshBootstrap();
    state.week = data;
    render();
  } catch (e) { reportError(e); }
}

async function confirmWeek() {
  var ok = await confirmAction(
    'Confirm this week?',
    'The days that have already passed are locked. Today and later can still be swapped.',
    'Confirm'
  );
  if (!ok) return;
  try {
    var data = await api('POST', '/api/weeks/' + state.week.week.id + '/confirm', {});
    state.week = data;
    render();
    toast('Week confirmed');
  } catch (e) { reportError(e); }
}

async function discardDraft() {
  try {
    var data = await api('DELETE', '/api/weeks/' + state.week.week.id + '/candidates');
    state.week = data;
    render();
  } catch (e) { reportError(e); }
}

async function generate() {
  if (!state.week) return;
  try {
    var data = await api('POST', '/api/weeks/' + state.week.week.id + '/generate', {});
    state.week = data;
    state.editingDay = null;
    render();
    toast('Generated ' + (data.candidates ? data.candidates.length : 0) + ' wishlists');
  } catch (e) { reportError(e); }
}

async function savePlan(cand) {
  var totals = state.week.totals || {};
  if (state.week.planId && totals.priced > 0) {
    var ok = await confirmAction(
      'Replace this week\u2019s plan?',
      totals.priced + ' lines are priced already. Any item that appears in both plans keeps its price; the rest lose theirs.',
      'Replace'
    );
    if (!ok) return;
  }
  try {
    var data = await api('POST', '/api/weeks/' + state.week.week.id + '/save', { planId: cand.id });
    await refreshBootstrap();
    state.week = data;
    state.tab = 'shop';
    render();
    toast('Saved as this week\u2019s template. The shopping list is ready.');
  } catch (e) { reportError(e); }
}

async function swapSlot(dayId, slot, value) {
  try {
    var data = await api('PATCH', '/api/days/' + dayId + '/slot', { slot: slot, itemId: value === '' ? null : Number(value) });
    state.week = data;
    render();
  } catch (e) { reportError(e); render(); }
}

async function swapGourmet(dayId, value) {
  try {
    var data = await api('PATCH', '/api/days/' + dayId + '/gourmet', { gourmetId: value === '' ? null : Number(value) });
    state.week = data;
    render();
  } catch (e) { reportError(e); render(); }
}

async function saveBudget(value) {
  try {
    var data = await api('PATCH', '/api/weeks/' + state.week.week.id, { budget: value });
    state.week = data;
    render();
  } catch (e) { reportError(e); }
}

async function archiveWeek() {
  var ok = await confirmAction('Archive this week?', 'It is snapshotted into history with its own copy of names and prices, and closed for editing.', 'Archive');
  if (!ok) return;
  try {
    await api('POST', '/api/weeks/' + state.week.week.id + '/archive', {});
    await refreshBootstrap();
    state.week = null;
    state.history = null;
    state.tab = 'history';
    render();
  } catch (e) { reportError(e); }
}

async function editGroup(group) {
  var values = await formModal('Edit ' + group.name, [
    { name: 'name', label: 'Name', value: group.name, required: true },
    { name: 'isPantry', label: 'Pantry group', type: 'select', value: group.isPantry ? '1' : '0', options: [{ value: '0', label: 'No' }, { value: '1', label: 'Yes, on every shopping list' }] }
  ]);
  if (!values) return;
  try {
    await api('PATCH', '/api/groups/' + group.id, { name: values.name, isPantry: values.isPantry === '1' });
    await refreshBootstrap();
    render();
  } catch (e) { reportError(e); }
}

async function deleteGroup(group) {
  var ok = await confirmAction('Delete ' + group.name + '?', 'It leaves the catalog. Past weeks and history keep working.', 'Delete');
  if (!ok) return;
  try { await api('DELETE', '/api/groups/' + group.id); await refreshBootstrap(); render(); } catch (e) { reportError(e); }
}

async function editSubgroup(group, sub) {
  var values = await formModal('Edit ' + sub.name, [
    { name: 'name', label: 'Name', value: sub.name, required: true },
    {
      name: 'icon', label: 'Icon (optional)', value: sub.icon || '', placeholder: '🐔',
      hint: 'Shown in front of this group\u2019s items on the plan. Leave blank for none.'
    },
    { name: 'groupId', label: 'Main group', type: 'select', value: String(group.id), options: catalogGroups().map(function (g) { return { value: String(g.id), label: g.name }; }) },
    {
      name: 'slotRole', label: 'Slot', value: sub.slotRole,
      type: 'select',
      options: [
        { value: 'protein', label: 'protein slot' },
        { value: 'side', label: 'side slot' },
        { value: 'salad', label: 'salad slot' },
        { value: 'none', label: 'no slot (pantry)' }
      ],
      hint: 'Only groups with a slot are ever drawn into a day.'
    }
  ]);
  if (!values) return;
  try {
    await api('PATCH', '/api/subgroups/' + sub.id, {
      name: values.name,
      icon: values.icon.trim(),
      groupId: Number(values.groupId),
      slotRole: values.slotRole
    });
    await refreshBootstrap();
    render();
  } catch (e) { reportError(e); }
}

async function deleteSubgroup(sub) {
  var ok = await confirmAction('Delete ' + sub.name + '?', 'Its items leave the catalog. Past weeks and history are unaffected.', 'Delete');
  if (!ok) return;
  try { await api('DELETE', '/api/subgroups/' + sub.id); await refreshBootstrap(); render(); } catch (e) { reportError(e); }
}

async function editItem(item) {
  var values = await formModal('Edit item', [{ name: 'name', label: 'Name', value: item.name, required: true }]);
  if (!values) return;
  try { await api('PATCH', '/api/items/' + item.id, { name: values.name }); await refreshBootstrap(); render(); } catch (e) { reportError(e); }
}

async function deleteItem(item) {
  var ok = await confirmAction('Delete ' + item.name + '?', 'It leaves the catalog and cannot be drawn into new plans. Existing weeks and history keep working.', 'Delete');
  if (!ok) return;
  try { await api('DELETE', '/api/items/' + item.id); await refreshBootstrap(); render(); } catch (e) { reportError(e); }
}

async function toggleItem(item, selected) {
  try {
    await api('POST', '/api/items/selection', { ids: [item.id], selected: selected });
    await refreshBootstrap();
    render();
  } catch (e) { reportError(e); }
}

async function saveSettings(payload) {
  try { await api('PATCH', '/api/settings', payload); await refreshBootstrap(); render(); toast('Settings saved'); } catch (e) { reportError(e); }
}

async function removeUser(u) {
  var ok = await confirmAction('Remove ' + u.username + '?', 'Their sessions are ended and they can no longer sign in.', 'Remove');
  if (!ok) return;
  try { await api('DELETE', '/api/users/' + u.id); state.users = null; render(); } catch (e) { reportError(e); }
}

boot();
