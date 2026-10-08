/* ZABALENO – backend (Express + Google Sheets jako úložiště).
   Tabulka je soukromá; čte a zapisuje ji jen tento server přes servisní účet.
   Oprávnění rolí se kontrolují TADY na serveru. */
'use strict';
const express = require('express'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), cookieParser = require('cookie-parser');
const path = require('path'), crypto = require('crypto'), { GoogleAuth } = require('google-auth-library');

const { JWT_SECRET, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON } = process.env;
if (!JWT_SECRET || !SHEET_ID) { console.error('Chybí JWT_SECRET nebo SHEET_ID'); process.exit(1); }
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Google service-account credentials can be supplied either as a Render
// environment variable or (preferably) as a Render Secret File.  We also
// normalize escaped newlines because Render/JSON copying can turn the PEM
// line breaks into literal \\n characters.
const fs = require('fs');
const SECRET_FILE = '/etc/secrets/google-service-account.json';
let serviceAccount;
try {
  let raw;
  if (fs.existsSync(SECRET_FILE)) {
    raw = fs.readFileSync(SECRET_FILE, 'utf8');
    console.log('Google credentials: using Render Secret File');
  } else if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    raw = GOOGLE_SERVICE_ACCOUNT_JSON;
    console.log('Google credentials: using GOOGLE_SERVICE_ACCOUNT_JSON');
  } else {
    throw new Error('Chybí GOOGLE_SERVICE_ACCOUNT_JSON nebo /etc/secrets/google-service-account.json');
  }
  serviceAccount = JSON.parse(raw);
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Service account JSON neobsahuje client_email nebo private_key');
  }
  serviceAccount.private_key = String(serviceAccount.private_key)
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim() + '\n';
  // Fail early with a useful error instead of the opaque OpenSSL decoder error.
  const keyObject = crypto.createPrivateKey({
    key: serviceAccount.private_key,
    format: 'pem',
    type: 'pkcs8'
  });
  serviceAccount.private_key = keyObject.export({ format: 'pem', type: 'pkcs8' }).toString();
} catch (e) {
  console.error('Google Service Account není použitelný:', e.message);
  process.exit(1);
}
const gauth = new GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const w = f => (q, s, n) => f(q, s, n).catch(n);
async function gs(method, p, body) {                              // volání Google Sheets API
  const h = { 'Content-Type': 'application/json' }; if (gauth) h.Authorization = 'Bearer ' + await gauth.getAccessToken();
  const r = await fetch(`${API}/${SHEET_ID}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Google Sheets: ' + (j.error?.message || r.status)), { status: 502 });
  return j;
}

/* ---- úložiště: každý list = jedna kolekce; sloupec A = id, B = data (JSON), další sloupce jen pro čitelnost ---- */
const sum = a => a.reduce((s, i) => s + i.qty * i.price, 0);
const TABS = {
  products: d => [d.name, d.size, d.weight, d.hours, d.matPerKg, d.hourRate, d.giftPackage, d.price, d.image || '', d.active ? 'ano' : 'ne'],
  orders: d => [d.num, d.date, d.customer, d.status, sum(d.items)],
  sales: d => [d.date, d.num || 'ruční', sum(d.lines)],
  tasks: d => [d.num, d.customer, d.due, d.status],
  notifs: d => [d.to, d.text, d.read ? 'ano' : 'ne'],
  settings: () => []
};
const HEAD = { products: ['id', 'data', 'název', 'velikost', 'hmotnost g', 'čas tisku h', 'materiál Kč/kg', 'tisk Kč/h', 'dárkové balení Kč/ks', 'prodejní cena', 'obrázek', 'aktivní'], orders: ['id', 'data', 'číslo', 'datum', 'zákazník', 'stav', 'celkem Kč'],
  sales: ['id', 'data', 'datum', 'objednávka', 'celkem Kč'], tasks: ['id', 'data', 'číslo', 'zákazník', 'termín', 'stav'], notifs: ['id', 'data', 'komu', 'text', 'přečteno'], settings: ['id', 'data'] };
const S = {}; for (const t in TABS) S[t] = { docs: new Map(), row: new Map(), next: 2, grid: 1000, sheetId: null };   // cache v paměti serveru
const all = t => [...S[t].docs.values()];

let queue = Promise.resolve();                                    // zápisy jdou po jednom (žádné souběhy)
const lock = f => { const r = queue.then(f); queue = r.catch(() => {}); return r; };

async function reload() {                                         // načte všechna data z tabulky do cache
  const names = Object.keys(TABS);
  const j = await gs('GET', '/values:batchGet?majorDimension=ROWS&' + names.map(t => 'ranges=' + encodeURIComponent(`${t}!A2:B`)).join('&'));
  let changed = false;
  j.valueRanges.forEach((vr, i) => {
    const st = S[names[i]], docs = new Map(), row = new Map(), v = vr.values || [];
    v.forEach((r, k) => { if (r[0] && r[1]) try { docs.set(r[0], JSON.parse(r[1])); row.set(r[0], k + 2); } catch { /* poškozený řádek přeskočit */ } });
    if (JSON.stringify([...docs]) !== JSON.stringify([...st.docs])) changed = true;
    st.docs = docs; st.row = row; st.next = v.length + 2;
  });
  return changed;
}
async function init() {                                           // vytvoří chybějící listy a záhlaví
  let meta = await gs('GET', '?fields=sheets.properties');
  const miss = Object.keys(TABS).filter(t => !meta.sheets.some(s => s.properties.title === t));
  if (miss.length) { await gs('POST', ':batchUpdate', { requests: miss.map(t => ({ addSheet: { properties: { title: t, gridProperties: { rowCount: 2000, columnCount: 10 } } } })) }); meta = await gs('GET', '?fields=sheets.properties'); }
  for (const s of meta.sheets) { const t = S[s.properties.title]; if (t) { t.sheetId = s.properties.sheetId; t.grid = s.properties.gridProperties.rowCount; } }
  await gs('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: Object.keys(TABS).map(t => ({ range: `${t}!A1`, values: [HEAD[t]] })) });
  await reload();
}
/* commit: ops = [{tab,id,doc}] pro zápis, [{tab,id,del:1}] pro smazání (řádek se vyprázdní).
   Všechny změny jedné akce jdou do tabulky JEDNÍM požadavkem. Cache se změní až po úspěchu. */
function commit(opsOrFn) {
  return lock(async () => {
    const ops = typeof opsOrFn === 'function' ? opsOrFn() : opsOrFn, plan = [], nx = {};
    for (const o of ops) {
      const st = S[o.tab]; let r = st.row.get(o.id);
      if (!r) { if (o.del) continue; r = nx[o.tab] ?? st.next; nx[o.tab] = r + 1; }
      plan.push({ o, r });
    }
    if (!plan.length) return;
    for (const t in nx) if (nx[t] > S[t].grid) { await gs('POST', ':batchUpdate', { requests: [{ appendDimension: { sheetId: S[t].sheetId, dimension: 'ROWS', length: 2000 } }] }); S[t].grid += 2000; }
    await gs('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: plan.map(({ o, r }) => ({ range: `${o.tab}!A${r}`,
      values: [o.del ? Array(8).fill('') : [o.id, JSON.stringify(o.doc), ...TABS[o.tab](o.doc)]] })) });
    for (const { o, r } of plan) { const st = S[o.tab]; if (o.del) { st.docs.delete(o.id); st.row.delete(o.id); } else { st.docs.set(o.id, o.doc); st.row.set(o.id, r); st.next = Math.max(st.next, r + 1); } }
    bump();
  });
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }), cookieParser());

/* ---- autentizace: účty z proměnných prostředí, JWT v httpOnly cookie ---- */
const USERS = [['ADMIN', 'admin', 'Veronika'], ['PARTNER', 'partner', 'Partner']].filter(([p]) => process.env[p + '_EMAIL'] && process.env[p + '_PASSWORD'])
  .map(([p, role, name]) => ({ email: process.env[p + '_EMAIL'].trim().toLowerCase(), hash: bcrypt.hashSync(process.env[p + '_PASSWORD'], 10), role, name }));
const auth = (q, s, n) => { try { q.user = jwt.verify(q.cookies.zt, JWT_SECRET); n(); } catch { s.status(401).json({ error: 'Nejste přihlášena' }); } };
const admin = (q, s, n) => q.user.role === 'admin' ? n() : s.status(403).json({ error: 'Nedostatečná oprávnění' });
const fails = new Map();
app.post('/api/login', w(async (q, s) => {
  const f = fails.get(q.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 9e5) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) throw bad('Příliš mnoho pokusů, zkuste to za 15 minut.', 429);
  const { email, password, remember } = q.body || {}, u = USERS.find(x => x.email === String(email || '').trim().toLowerCase());
  if (!u || !(await bcrypt.compare(String(password || ''), u.hash))) { fails.set(q.ip, { n: f.n + 1, t: f.t }); throw bad('Nesprávný email nebo heslo', 401); }
  fails.delete(q.ip);
  s.cookie('zt', jwt.sign({ role: u.role, name: u.name }, JWT_SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', ...(remember ? { maxAge: 30 * 864e5 } : {}) });
  s.json({ ok: 1 });
}));
app.get('/api/public-stats', (q, s) => {
  const liveOrders = all('orders').filter(o => o.status !== 'cancelled');
  const inProduction = liveOrders.filter(o => o.status === 'progress').length;
  const notInProduction = liveOrders.filter(o => o.status === 'new' || o.status === 'read').length;
  s.set('Cache-Control', 'no-store');
  s.json({ total: liveOrders.length, inProduction, notInProduction, updatedAt: new Date().toISOString() });
});

app.post('/api/logout', (q, s) => { s.clearCookie('zt'); s.json({ ok: 1 }); });
app.get('/api/me', auth, (q, s) => s.json({ name: q.user.name, role: q.user.role }));

const clients = new Set(), bump = () => clients.forEach(r => r.write('data: change\n\n'));   // živé změny: klient dostane jen „change“
app.get('/api/events', auth, (q, s) => {
  s.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); s.flushHeaders();
  clients.add(s); const h = setInterval(() => s.write(': ping\n\n'), 25000);
  q.on('close', () => { clearInterval(h); clients.delete(s); });
});

/* ---- doménová logika ---- */
const ORDER_ST = ['new', 'read', 'progress', 'done', 'cancelled'];
const notif = (to, text) => ({ tab: 'notifs', id: crypto.randomUUID(), doc: { id: '', to, text, title: /převzal|převzetí/i.test(text) ? 'Objednávka převzata' : /dokončena/i.test(text) ? 'Objednávka dokončena' : /zahájena/i.test(text) ? 'Výroba zahájena' : 'Nová objednávka', ts: Date.now(), read: false } });
const fixN = o => (o.doc.id = o.id, o);
const cleanItems = a => a.map(i => {
  if (!(Number.isInteger(+i.qty) && +i.qty > 0 && +i.price >= 0 && +i.cost >= 0) || !String(i.pname || '').trim()) throw bad('Neplatná položka (množství nebo cena)');
  return { pid: i.pid || null, pname: i.pname, qty: +i.qty, price: +i.price, cost: +i.cost, my: +i.my, partner: +i.partner, vars: i.vars || {} };
});
const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || b.ts - a.ts;
const M = {
  products: {
    list: () => all('products').sort((a, b) => a.name.localeCompare(b.name, 'cs')),
    put(id, d) {
      if (!String(d.name || '').trim()) throw bad('Zadejte název produktu');
      const nums = ['weight','hours','matPerKg','hourRate','giftPackage','price'];
      if (!nums.every(k => isFinite(+d[k]) && +d[k] >= 0)) throw bad('Neplatné údaje produktu');
      return [{ tab: 'products', id, doc: {
        id, name: d.name.trim(), size: d.size || '', weight: +d.weight, hours: +d.hours,
        matPerKg: +d.matPerKg, hourRate: +d.hourRate, giftPackage: +d.giftPackage || 0, price: +d.price, image: d.image || '',
        demo: !!d.demo, active: d.active !== false
      } }];
    },
    del: id => [{ tab: 'products', id, del: 1 }]
  },
  orders: {
    list: () => all('orders').sort(byDate),
    put(id, d) {
      if (!String(d.customer || '').trim() || !String(d.num || '').trim() || !Array.isArray(d.items) || !d.items.length || !d.date) throw bad('Neplatná objednávka');
      if (!ORDER_ST.includes(d.status || 'new')) throw bad('Neplatný stav');
      const items = cleanItems(d.items), num = d.num.trim(), old = S.orders.docs.get(id), ot = S.tasks.docs.get(id);
      if (all('orders').some(o => o.num === num && o.id !== id)) throw bad('Číslo objednávky už existuje', 409);
      const o = { id, num, date: d.date, due: d.due || '', customer: d.customer.trim(), contact: d.contact || '', ship: d.ship || '', note: d.note || '', status: d.status || 'nova', ts: old ? old.ts : Date.now(), items };
      const task = { id, oid: id, num, customer: o.customer, due: o.due, note: o.note, items: items.map(i => ({ pname: i.pname, qty: i.qty, vars: i.vars })), status: ot ? ot.status : 'new', ts: ot ? ot.ts : Date.now() };
      const sid = 'o_' + id, ops = [{ tab: 'orders', id, doc: o }, { tab: 'tasks', id, doc: task },
        o.status === 'cancelled' ? { tab: 'sales', id: sid, del: 1 } : { tab: 'sales', id: sid, doc: { id: sid, oid: id, num, date: o.date, ts: Date.now(), lines: items } }];
      if (!old) ops.push(fixN(notif('partner', `Objednávka #${num} čeká na výrobu: ${items.map(i => `${i.qty}× ${i.pname}`).join(', ')}.`)));
      return ops;
    },
    del: id => [{ tab: 'orders', id, del: 1 }, { tab: 'tasks', id, del: 1 }, { tab: 'sales', id: 'o_' + id, del: 1 }]
  },
  sales: {
    list: () => all('sales').sort(byDate),
    put(id, d) {
      if (!d.date || !Array.isArray(d.lines) || !d.lines.length) throw bad('Neplatný prodej');
      const ex = S.sales.docs.get(id); if (ex && ex.oid) throw bad('Prodej z objednávky se mění přes objednávku', 409);
      return [{ tab: 'sales', id, doc: { id, oid: null, num: null, date: d.date, ts: ex ? ex.ts : Date.now(), lines: cleanItems(d.lines) } }];
    },
    del(id) { const ex = S.sales.docs.get(id); if (ex && ex.oid) throw bad('Prodej z objednávky se maže přes objednávku', 409); return [{ tab: 'sales', id, del: 1 }]; }
  },
  production: {
    list: () => all('tasks').sort((a, b) => b.ts - a.ts),
    put(id, d, role) {
      const t = S.tasks.docs.get(id), s = String(d.status || '');
      const allowed = ['new', 'read', 'progress', 'done'];
      if (!t) throw bad('Úkol nenalezen', 404);
      if (!allowed.includes(s)) throw bad('Neplatný stav');
      const o = S.orders.docs.get(id);
      if (!o) throw bad('Objednávka nenalezena', 404);
      const previous = o.status;
      const ops = [{ tab: 'tasks', id, doc: { ...t, status: s, updatedAt: Date.now(), updatedBy: role } },
                   { tab: 'orders', id, doc: { ...o, status: s, updatedAt: Date.now(), updatedBy: role } }];
      if (previous !== s) {
        if (s === 'read') ops.push(fixN(notif('admin', `Partner potvrdil převzetí objednávky #${t.num}.`)));
        if (s === 'progress') ops.push(fixN(notif('admin', `Výroba objednávky #${t.num} byla zahájena.`)));
        if (s === 'done') ops.push(fixN(notif('admin', `Objednávka #${t.num} byla dokončena.`)));
        if (role === 'admin' && s !== 'new') ops.push(fixN(notif('partner', `Stav objednávky #${t.num} byl změněn na ${s === 'read' ? 'Přečteno' : s === 'progress' ? 'V procesu' : 'Dokončeno'}.`)));
      }
      return ops;
    }
  }
};
function crud(name, m, ...guards) {
  const ok = id => /^[\w-]{1,64}$/.test(String(id)) ? String(id) : (() => { throw bad('Neplatné ID'); })();
  app.get(`/api/${name}`, auth, ...guards, (q, s) => s.json(m.list()));
  const up = w(async (q, s) => { const id = ok(q.params.id || q.body.id); await commit(() => m.put(id, q.body || {})); s.json({ ok: 1 }); });
  app.post(`/api/${name}`, auth, ...guards, up); app.put(`/api/${name}/:id`, auth, ...guards, up);
  if (m.del) app.delete(`/api/${name}/:id`, auth, ...guards, w(async (q, s) => { const id = ok(q.params.id); await commit(() => m.del(id)); s.json({ ok: 1 }); }));
}
app.get('/api/products', auth, (q, s) => s.json(M.products.list()));
const productId = id => /^[\w-]{1,64}$/.test(String(id)) ? String(id) : (() => { throw bad('Neplatné ID'); })();
app.post('/api/products', auth, admin, w(async (q, s) => { const id = productId(q.body.id); await commit(() => M.products.put(id, q.body || {})); s.json({ ok: 1 }); }));
app.put('/api/products/:id', auth, admin, w(async (q, s) => { const id = productId(q.params.id); await commit(() => M.products.put(id, q.body || {})); s.json({ ok: 1 }); }));
app.delete('/api/products/:id', auth, admin, w(async (q, s) => { const id = productId(q.params.id); await commit(() => M.products.del(id)); s.json({ ok: 1 }); }));
// Objednávky: partner je může pouze ČÍST; vytvářet, upravovat stav/cenu a mazat je smí jen admin.
app.get('/api/orders', auth, (q, s) => s.json(M.orders.list()));
crud('orders', M.orders, admin);
// Prodeje: výhradně admin.
crud('sales', M.sales, admin);
// Výroba: partner i admin mohou číst a měnit pouze výrobní stav (M.production.put ignoruje ostatní pole).
app.get('/api/production', auth, (q, s) => s.json(M.production.list()));
app.put('/api/production/:id', auth, w(async (q, s) => { const id = productId(q.params.id); await commit(() => M.production.put(id, q.body || {}, q.user.role)); s.json({ ok: 1 }); }));

app.patch('/api/orders/:id/status', auth, admin, w(async (q, s) => {
  const id = String(q.params.id), status = String(q.body?.status || '');
  if (!ORDER_ST.includes(status)) throw bad('Neplatný stav');
  const old = S.orders.docs.get(id); if (!old) throw bad('Objednávka nenalezena', 404);
  await commit([{ tab: 'orders', id, doc: { ...old, status } }]);
  s.json({ ok: 1 });
}));

app.get('/api/notifications', auth, (q, s) => s.json(all('notifs').filter(n => n.to === q.user.role).sort((a, b) => b.ts - a.ts).slice(0, 100)));
app.put('/api/notifications/:id/read', auth, w(async (q, s) => {
  await commit(() => { const n = S.notifs.docs.get(q.params.id); return n && n.to === q.user.role ? [{ tab: 'notifs', id: n.id, doc: { ...n, read: true } }] : []; }); s.json({ ok: 1 });
}));
app.get('/api/settings', auth, (q, s) => s.json(S.settings.docs.get('main') || {}));
app.put('/api/settings', auth, admin, w(async (q, s) => {
  const { me, partner } = q.body || {};
  await commit([{ tab: 'settings', id: 'main', doc: { id: 'main', me: String(me || 'Já').slice(0, 60), partner: String(partner || 'Partner').slice(0, 60) } }]); s.json({ ok: 1 });
}));

app.get('/healthz', (q, s) => s.send('ok'));
app.use('/api', (q, s) => s.status(404).json({ error: 'Nenalezeno' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((e, q, s, n) => {
  const code = e.status || 500; if (code === 500) console.error(e);
  s.status(code).json({ error: code === 500 ? 'Chyba serveru' : e.message });
});

init().then(() => {
  setInterval(() => lock(reload).then(c => c && bump()).catch(e => console.error('reload:', e.message)), 60000);   // zachytí ruční úpravy v tabulce
  app.listen(process.env.PORT || 3000, () => console.log('ZABALENO běží (Google Sheets)'));
}).catch(e => { console.error(e); process.exit(1); });
