/* ZABALENO – Interní dashboard (Google Sheets backend) */
(function () {
'use strict';

/* ---------- 3) PŘIHLÁŠENÍ + API DATA ---------- */
const STATUS_DB = { new: 'Nová', read: 'Přečteno', progress: 'V procesu', done: 'Dokončeno', cancelled: 'Zrušeno' };
const STATUS_KEY = Object.fromEntries(Object.entries(STATUS_DB).map(([k, v]) => [v, k]));
const RANK = { new: 0, read: 1, progress: 2, done: 3, cancelled: 0 };

const CONFIG = {
  users: {
    veronika: { name: 'Veronika', vocative: 'Veroniko', role: 'admin' },
    partner:  { name: 'Partner',  vocative: 'Partnere', role: 'partner' }
  },
  statuses: {
    new: ['🟡', 'Nová'], read: ['🔵', 'Přečteno'], progress: ['🟠', 'V procesu'],
    done: ['🟢', 'Dokončeno'], cancelled: ['🔴', 'Zrušeno']
  }
};

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  let data = null; try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw Object.assign(new Error(data?.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}
function errMsg(e) {
  const m = (e && e.message) || '';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Zkontrolujte připojení k internetu.';
  if (/Nesprávný email nebo heslo/i.test(m)) return 'Nesprávný email nebo heslo.';
  if (/Nedostatečná oprávnění/i.test(m)) return 'Nemáte oprávnění k této akci.';
  if (/Nejste přihlášena/i.test(m)) return 'Přihlášení vypršelo. Přihlaste se znovu.';
  return m || 'Neznámá chyba.';
}

const Auth = {
  id: null,
  current() { return this.id; },
  async login(email, pass, remember) {
    await api('/api/login', { method: 'POST', body: { email: email.trim(), password: pass, remember: !!remember } });
    const m = await api('/api/me');
    const role = m.role === 'admin' ? 'admin' : 'partner';
    this.id = role === 'admin' ? 'veronika' : 'partner';
    return { user: { name: m.name, role }, me: m };
  },
  async logout() { await api('/api/logout', { method: 'POST' }); this.id = null; }
};
function userFor(m) {
  const role = m.role === 'admin' ? 'admin' : 'partner';
  const id = role === 'admin' ? 'veronika' : 'partner';
  const base = CONFIG.users[id];
  return { id, ...base, name: m.name || base.name };
}

function fromDoc(r) {
  const i = Array.isArray(r.items) && r.items[0] ? r.items[0] : {};
  const total = Array.isArray(r.items) ? r.items.reduce((s, x) => s + (+x.qty || 0) * (+x.price || 0), 0) : 0;
  const cost = Array.isArray(r.items) ? r.items.reduce((s, x) => s + (+x.qty || 0) * (+x.cost || 0), 0) : 0;
  return { id: r.id, number: r.num || '', date: r.date || new Date().toISOString(), customer: r.customer || '', contact: r.contact || '',
    productId: i.pname || '', variant: i.vars?.variant || '', qty: Number(i.qty) || 0, unitPrice: Number(i.price) || 0,
    total, cost, profit: total - cost, due: r.due || '', note: r.note || '', status: r.status || 'new' };
}
const Products = {
  cache: [],
  async load() { this.cache = await api('/api/products'); },
  async save(p) { const exists = this.cache.some(x => x.id === p.id); await api(exists ? `/api/products/${encodeURIComponent(p.id)}` : '/api/products', { method: exists ? 'PUT' : 'POST', body: p }); await this.load(); },
  async remove(id) { await api(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' }); await this.load(); }
};
const Orders = {
  cache: [],
  async load() { this.cache = (await api('/api/orders')).map(fromDoc); },
  async insert(o) { await api('/api/orders', { method: 'POST', body: o }); await this.load(); return this.cache.find(x => x.id === o.id) || this.cache.find(x => x.number === o.num); },
  async update(id, patch) {
    if (patch.status) await api(`/api/orders/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status: patch.status } });
    await this.load(); return this.cache.find(x => String(x.id) === String(id));
  },
  async remove(id) { await api(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }); this.cache = this.cache.filter(x => String(x.id) !== String(id)); }
};
const Notifs = {
  cache: [],
  async load() { this.cache = (await api('/api/notifications')).map(n => ({ ...n, date: n.date || new Date(n.ts || Date.now()).toISOString(), title: n.title || 'Upozornění' })); },
  async read(id) { await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' }); const n=this.cache.find(x=>x.id===id); if(n)n.read=true; }
};
const DB = {
  get(name) { if (name === 'products') return Products.cache; if (name === 'notifs') return Notifs.cache; return []; },
  set() {}, init() {}
};

/* ---------- 4) POMOCNÉ VÝPOČTY ---------- */
const prodMaterial = p => p.weight / 1000 * p.matPerKg;
const prodCost = p => prodMaterial(p) + p.hours * p.hourRate;       // materiál + hodiny × cena za hodinu
const money = n => Math.round(n).toLocaleString('cs-CZ') + ' Kč';
const dt = i => i ? new Date(i).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' }) : '';
const dd = i => new Date(i).toLocaleDateString('cs-CZ');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const badge = s => `<span class="badge s-${s}">${CONFIG.statuses[s][0]} ${CONFIG.statuses[s][1]}</span>`;
const same = (iso, d) => new Date(iso).toDateString() === d.toDateString();

let me = null, state = { view: 'dashboard', f: {} };
const $ = s => document.querySelector(s);
const isAdmin = () => me.role === 'admin';
const orders = () => Orders.cache, products = () => Products.cache;
const prod = id => products().find(p => p.id === id || p.name === id) || { name: id || '(neznámý produkt)', weight: 0, hours: 0 };
const live = () => orders().filter(o => o.status !== 'cancelled');

function nextId() {
  const y = new Date().getFullYear();
  const max = Math.max(0, ...orders().filter(o => String(o.number).startsWith(y)).map(o => +String(o.number).split('-')[1] || 0));
  return `${y}-${String(max + 1).padStart(3, '0')}`;
}
function notify(to, title, text) {
  const n = DB.get('notifs'); n.unshift({ id: Date.now() + Math.random(), to, title, text, date: new Date().toISOString(), read: false });
  DB.set('notifs', n);
}
async function setStatus(id, status) { // změna stavu přes server; časové značky kroků tabulka nemá
  await Orders.update(id, { status: STATUS_DB[status] });
}

/* ---------- 5) POHLEDY (vracejí HTML) ---------- */
const NAV = [
  ['dashboard', '📊', 'Dashboard'], ['orders', '🛒', 'Objednávky'], ['new', '➕', 'Nová objednávka', 'admin'],
  ['production', '🖨️', 'Výroba'], ['products', '📦', 'Produkty', 'admin'], ['sales', '💰', 'Prodeje', 'admin'],
  ['notifs', '🔔', 'Upozornění'], ['settings', '⚙️', 'Nastavení', 'admin']
];
const myNotifs = () => Notifs.cache;

function stat(l, v, g) { return `<div class="card stat ${g ? 'gold' : ''}"><small>${l}</small><b>${v}</b></div>`; }

function orderTable(list) {
  if (!list.length) return '<div class="empty">Žádné objednávky. Začněte tlačítkem „+ Nová objednávka“.</div>';
  const fin = isAdmin();
  return `<div class="tw"><table><tr><th>ID</th><th>Datum</th><th>Zákazník</th><th>Produkt</th><th>Počet</th>${fin ? '<th>Cena</th>' : ''}<th>Stav</th><th>Akce</th></tr>` +
    list.map(o => `<tr><td>#${o.number}</td><td>${dd(o.date)}</td><td>${esc(o.customer)}</td><td>${esc(prod(o.productId).name)}</td><td>${o.qty} ks</td>${fin ? `<td>${money(o.total)}</td>` : ''}<td>${badge(o.status)}</td>
    <td><button class="btn ghost sm" data-act="open" data-id="${o.id}">Detail</button></td></tr>`).join('') + '</table></div>';
}

const views = {
  dashboard() {
    const o = live(), h = new Date().getHours(), hi = h < 10 ? 'Dobré ráno' : h < 18 ? 'Dobrý den' : 'Dobrý večer';
    const fin = isAdmin() ? stat('Tržby', money(sum(o, x => x.total)), 1) + stat('Zisk', money(sum(o, x => x.profit)), 1) : '';
    return `<div class="head"><div><h1>${hi}, ${me.vocative} 👋</h1><span class="mute">${new Date().toLocaleDateString('cs-CZ', { dateStyle: 'full' })}</span></div></div>
    <div class="grid">${stat('Dnešní objednávky', orders().filter(x => same(x.date, new Date())).length)}${stat('Objednávky celkem', orders().length)}
    ${stat('Ve výrobě', orders().filter(x => x.status === 'progress').length)}${stat('Dokončené', orders().filter(x => x.status === 'done').length)}${fin}</div>
    <div class="card"><h2>Poslední objednávky</h2>${orderTable(orders().slice().reverse().slice(0, 6))}</div>`;
  },
  orders() {
    const f = state.f, ps = products(), cs = [...new Set(orders().map(o => o.customer))];
    const q = (f.q || '').toLowerCase();
    const list = orders().filter(o => (!q || (o.id + o.customer + prod(o.productId).name).toLowerCase().includes(q)) && (!f.s || o.status === f.s) &&
      (!f.p || o.productId === f.p) && (!f.c || o.customer === f.c) && (!f.from || o.date.slice(0, 10) >= f.from) && (!f.to || o.date.slice(0, 10) <= f.to)).reverse();
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`;
    return `<div class="head"><h1>Objednávky</h1>${isAdmin() ? '<button class="btn gold" data-act="new">+ Nová objednávka</button>' : ''}</div>
    <div class="card"><div class="filters" id="filters">
      <input data-f="q" placeholder="🔍 Hledat objednávku..." value="${esc(f.q || '')}">
      <select data-f="s"><option value="">Všechny stavy</option>${Object.keys(CONFIG.statuses).map(k => opt(k, CONFIG.statuses[k][1], f.s)).join('')}</select>
      <select data-f="p"><option value="">Všechny produkty</option>${ps.map(p => opt(p.name, p.name, f.p)).join('')}</select>
      <select data-f="c"><option value="">Všichni zákazníci</option>${cs.map(c => opt(c, c, f.c)).join('')}</select>
      <input type="date" data-f="from" value="${f.from || ''}" title="Od"><input type="date" data-f="to" value="${f.to || ''}" title="Do"></div>
    <div id="olist">${orderTable(list)}</div></div>`;
  },
  production() {
    const all = orders(), todo = all.filter(o => ['new', 'read', 'progress'].includes(o.status)), done = all.filter(o => o.status === 'done');
    const label = { new: 'Označit jako přečtené', read: 'Zahájit výrobu', progress: 'Dokončit' }, nxt = { new: 'read', read: 'progress', progress: 'done' };
    const card = o => { const p = prod(o.productId); return `<div class="card"><div class="row"><b>#${o.number}</b>${badge(o.status)}</div>
      <div class="kv"><span>Zákazník</span><span>${esc(o.customer)}</span><span>Produkt</span><span>${esc(p.name)} ${esc(o.variant)}</span><span>Počet kusů</span><span>${o.qty}</span>
      <span>Hodin tisku</span><span>${(o.qty * p.hours).toLocaleString('cs-CZ')} h</span><span>Materiál</span><span>${Math.round(o.qty * p.weight)} g</span>
      <span>Termín</span><span>${o.due ? dd(o.due) : '–'}</span></div>${o.note ? `<p class="mute">📝 ${esc(o.note)}</p>` : ''}
      ${nxt[o.status] ? `<button class="btn" data-act="status" data-id="${o.id}" data-s="${nxt[o.status]}">${label[o.status]}</button>` : ''}
      <button class="btn ghost sm" data-act="open" data-id="${o.id}">Detail</button></div>`; };
    return `<div class="head"><h1>Výroba</h1></div><h2>K vyrobení (${todo.length})</h2>
    <div class="grid wide">${todo.map(card).join('') || '<div class="empty">Nic k výrobě 🎉</div>'}</div>
    <h2>Dokončené (${done.length})</h2><div class="grid wide">${done.map(card).join('') || '<div class="empty">Zatím nic.</div>'}</div>`;
  },
  products() {
    return `<div class="head"><h1>Produkty</h1><button class="btn gold" data-act="prodForm">+ Přidat produkt</button></div><div class="grid wide">` +
      products().map(p => `<div class="card pcard">${p.image ? `<img src="${p.image}" alt="">` : '<div class="pimg">📦</div>'}<h2 style="margin-top:12px">${esc(p.name)}</h2>
      <div class="kv"><span>Velikost</span><span>${esc(p.size)}</span><span>Hmotnost</span><span>${p.weight} g</span><span>Čas tisku</span><span>${p.hours} h</span>
      <span>Materiál</span><span>${p.matPerKg} Kč/kg (${money(prodMaterial(p))})</span><span>Tisk</span><span>${p.hourRate} Kč/h (${money(p.hours * p.hourRate)})</span>
      <span>Výrobní cena</span><b>${money(prodCost(p))}</b><span>Prodejní cena</span><b>${money(p.price)}</b><span>Zisk</span><b>${money(p.price - prodCost(p))}</b></div>
      <div class="row"><button class="btn ghost sm" data-act="prodForm" data-id="${p.id}">Upravit</button><button class="btn ghost sm" data-act="delProd" data-id="${p.id}">Smazat</button></div></div>`).join('') +
      (products().length ? '' : '<div class="empty">Zatím žádné produkty.</div>') + '</div>';
  },
  sales() {
    const o = live(), now = new Date(), m = o.filter(x => new Date(x.date).getMonth() === now.getMonth() && new Date(x.date).getFullYear() === now.getFullYear());
    const mon = []; for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); mon.push({ l: d.toLocaleDateString('cs-CZ', { month: 'short' }), d }); }
    const per = mon.map(x => o.filter(y => { const d = new Date(y.date); return d.getMonth() === x.d.getMonth() && d.getFullYear() === x.d.getFullYear(); }));
    const chart = (vals, fmt) => { const mx = Math.max(1, ...vals); return `<div class="chart">${vals.map((v, i) => `<div><em>${fmt(v)}</em><i style="height:${v / mx * 100 * .8}%"></i>${mon[i].l}</div>`).join('')}</div>`; };
    return `<div class="head"><h1>Prodeje</h1></div><div class="grid">
    ${stat('Dnešní tržby', money(sum(o.filter(x => same(x.date, now)), x => x.total)))}${stat('Tržby tento měsíc', money(sum(m, x => x.total)))}${stat('Tržby celkem', money(sum(o, x => x.total)), 1)}
    ${stat('Počet objednávek', o.length)}${stat('Průměrná objednávka', money(o.length ? sum(o, x => x.total) / o.length : 0))}${stat('Výrobní náklady', money(sum(o, x => x.cost)))}${stat('Celkový zisk', money(sum(o, x => x.profit)), 1)}</div>
    <div class="card"><h2>Tržby podle měsíců</h2>${chart(per.map(a => sum(a, x => x.total)), v => v ? Math.round(v) : '')}</div>
    <div class="card"><h2>Počet objednávek podle měsíců</h2>${chart(per.map(a => a.length), v => v || '')}</div>`;
  },
  notifs() {
    const n = myNotifs();
    return `<div class="head"><h1>Upozornění</h1></div><div class="card">${n.map(x => `<div class="notif ${x.read ? '' : 'new'}">🔔 ${esc(x.title)}<br><span class="mute">${esc(x.text)} · ${dt(x.date)}</span></div>`).join('') || '<div class="empty">Žádná upozornění.</div>'}</div>`;
  },
  settings() {
    return `<div class="head"><h1>Nastavení</h1></div><div class="card"><h2>Data</h2><p class="mute">Objednávky, produkty a upozornění jsou uložené v Google Sheets a sdílí se mezi uživateli.</p>
    <div class="row"><button class="btn ghost" data-act="clearDemo">Odstranit demo produkty</button><button class="btn ghost" data-act="export">Stáhnout zálohu (JSON)</button><button class="btn ghost" data-act="resetAll">Smazat lokální data</button></div></div>`;
  }
};

/* ---------- formuláře a detail (modal) ---------- */
function modal(html) { $('#modal').innerHTML = `<div class="modal" data-act="closeBg"><div class="sheet">${html}</div></div>`; }
const closeModal = () => $('#modal').innerHTML = '';
let toastT;
function toast(t, ms = 2200) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => e.hidden = true, ms); }

function orderForm() {
  const ps = products(); if (!ps.length) return toast('Nejdřív přidejte produkt.');
  const p = ps[0];
  modal(`<h2>Nová objednávka #${nextId()}</h2><form id="orderForm" class="form">
    <label>Datum<input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
    <label>Termín dokončení<input type="date" name="due"></label>
    <label>Jméno zákazníka<input name="customer" required></label><label>Kontakt zákazníka<input name="contact"></label>
    <label>Produkt<select name="productId">${ps.map(x => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select></label>
    <label>Varianta (barva, velikost…)<input name="variant"></label>
    <label>Počet kusů<input type="number" name="qty" min="1" value="1" required></label><label>Cena za kus (Kč)<input type="number" step="any" name="unitPrice" value="${p.price}" required></label>
    <label>Celková cena (Kč)<input name="total" readonly></label><label>Náklady na výrobu (Kč)<input type="number" step="any" name="cost"></label>
    <label>Odhadovaný zisk (Kč)<input name="profit" readonly></label><span></span>
    <label class="full">Poznámka<textarea name="note" rows="2"></textarea></label>
    <div class="full row"><button class="btn gold" type="submit">Uložit objednávku</button><button class="btn ghost" type="button" data-act="close">Zrušit</button></div></form>`);
  calcForm(true);
}
function calcForm(reset) {
  const f = $('#orderForm').elements, p = prod(f.productId.value), q = +f.qty.value || 0;
  if (reset) { f.unitPrice.value = p.price; f.cost.value = Math.round(q * prodCost(p) * 100) / 100; }
  f.total.value = Math.round(q * f.unitPrice.value * 100) / 100;
  f.profit.value = Math.round((f.total.value - f.cost.value) * 100) / 100;
}
function orderDetail(id) {
  const o = orders().find(x => String(x.id) === String(id)), p = prod(o.productId), rk = RANK[o.status];
  const steps = [['Objednávka vytvořena', 0], ['Přečteno', 1], ['Výroba zahájena', 2], ['Dokončeno', 3]];
  const fin = isAdmin() ? `<span>Cena za kus</span><span>${money(o.unitPrice)}</span><span>Celková cena</span><b>${money(o.total)}</b><span>Náklady</span><span>${money(o.cost)}</span><span>Zisk</span><b>${money(o.profit)}</b>` : '';
  const nx = { new: 'read', read: 'progress', progress: 'done' }, lb = { read: 'Označit jako přečtené', progress: 'Zahájit výrobu', done: 'Dokončit' };
  modal(`<div class="row"><h2 style="margin:0">Objednávka #${o.number}</h2>${badge(o.status)}</div>
    <div class="kv"><span>Datum</span><span>${dd(o.date)}</span><span>Zákazník</span><span>${esc(o.customer)}</span><span>Kontakt</span><span>${esc(o.contact) || '–'}</span>
    <span>Produkt</span><span>${esc(p.name)} ${esc(o.variant)}</span><span>Počet</span><span>${o.qty} ks</span>${fin}
    <span>Hodin tisku</span><span>${o.qty * p.hours} h</span><span>Materiál</span><span>${Math.round(o.qty * p.weight)} g</span><span>Termín</span><span>${o.due ? dd(o.due) : '–'}</span><span>Poznámka</span><span>${esc(o.note) || '–'}</span></div>
    <ul class="tl">${steps.map(s => `<li class="${rk >= s[1] ? 'on' : ''}">${s[0]}<small>${s[1] === 0 ? dt(o.date) : rk >= s[1] ? 'splněno' : 'čeká'}</small></li>`).join('')}</ul>
    <div class="row">${nx[o.status] ? `<button class="btn" data-act="status" data-id="${o.id}" data-s="${nx[o.status]}">${lb[nx[o.status]]}</button>` : ''}
    ${isAdmin() && !['done', 'cancelled'].includes(o.status) ? `<button class="btn ghost" data-act="status" data-id="${o.id}" data-s="cancelled">Zrušit objednávku</button>` : ''}
    ${isAdmin() ? `<button class="btn ghost" data-act="delOrder" data-id="${o.id}">Smazat</button>` : ''}<button class="btn ghost" data-act="close">Zavřít</button></div>`);
}
function prodForm(id) {
  const p = products().find(x => x.id === id) || { name: '', size: '', weight: 100, hours: 5, matPerKg: 350, hourRate: 5.5, price: 100 };
  const n = (k, l) => `<label>${l}<input type="number" step="any" name="${k}" value="${p[k]}" required></label>`;
  modal(`<h2>${id ? 'Upravit' : 'Nový'} produkt</h2><form id="prodForm" class="form" data-id="${id || ''}">
    <label>Název<input name="name" value="${esc(p.name)}" required></label><label>Velikost<input name="size" value="${esc(p.size)}"></label>
    ${n('weight', 'Hmotnost (g)')}${n('hours', 'Čas tisku (h)')}${n('matPerKg', 'Materiál (Kč/kg)')}${n('hourRate', 'Tisk (Kč/h)')}${n('price', 'Prodejní cena (Kč)')}
    <label>Obrázek<input type="file" name="image" accept="image/*"></label>
    <div class="full row"><button class="btn gold" type="submit">Uložit produkt</button><button class="btn ghost" type="button" data-act="close">Zrušit</button></div></form>`);
}
function shrink(file) { // zmenší obrázek, aby se vešel do localStorage
  return new Promise(res => {
    if (!file) return res('');
    const r = new FileReader();
    r.onload = () => { const i = new Image(); i.onload = () => { const s = Math.min(1, 400 / i.width), c = document.createElement('canvas'); c.width = i.width * s; c.height = i.height * s;
      c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .7)); }; i.src = r.result; };
    r.readAsDataURL(file);
  });
}

/* ---------- 6) VYKRESLENÍ, API A REALTIME ---------- */
function render() {
  const nav = NAV.filter(n => !n[3] || isAdmin() || n[0] === 'x');
  const unread = myNotifs().filter(n => !n.read).length;
  if (state.view === 'notifs') Notifs.cache.filter(n => !n.read).forEach(n => Notifs.read(n.id).catch(console.error));
  $('#nav').innerHTML = nav.map(n => `<button class="${state.view === n[0] ? 'on' : ''}" data-act="${n[0] === 'new' ? 'new' : 'nav'}" data-v="${n[0]}">${n[1]} ${n[2]}${n[0] === 'notifs' && unread && state.view !== 'notifs' ? `<span class="n">${unread}</span>` : ''}</button>`).join('');
  $('#bellTop').hidden = !unread || state.view === 'notifs';
  $('#meName').textContent = me.name;
  $('#main').innerHTML = state.loading ? '<div class="card empty">⏳ Načítám data…</div>'
    : state.error ? `<div class="card empty">${esc(state.error)}<br><br><button class="btn" data-act="reload">Zkusit znovu</button></div>`
    : (isAdmin() || !['products', 'sales', 'settings'].includes(state.view) ? views[state.view] : views.dashboard)();
  $('#app').classList.remove('open');
}

async function loadPublicStats() {
  try {
    const d = await api('/api/public-stats');
    const fmt = n => Number(n || 0).toLocaleString('cs-CZ');
    $('#publicTotal').textContent = fmt(d.total);
    $('#publicProduction').textContent = fmt(d.inProduction);
    $('#publicWaiting').textContent = fmt(d.notInProduction);
    $('#publicUpdated').textContent = d.updatedAt ? 'Aktualizováno právě teď' : 'Aktuální data';
  } catch (e) {
    console.error('public stats:', e);
    $('#publicTotal').textContent = '—';
    $('#publicProduction').textContent = '—';
    $('#publicWaiting').textContent = '—';
    $('#publicUpdated').textContent = 'Data se nepodařilo načíst';
  }
}

const showLoginError = t => { const e = $('#loginErr'); e.textContent = t; e.hidden = !t; };
async function run(errText, fn) {
  if (state.busy) return; state.busy = true;
  try { await fn(); } catch (e) { console.error(e); toast(errText + ' ' + errMsg(e), 4500); } finally { state.busy = false; }
}
async function loadData() {
  state.loading = true; state.error = null; render();
  try { await Promise.all([Orders.load(), Products.load(), Notifs.load()]); }
  catch (e) { console.error(e); state.error = 'Data se nepodařilo načíst: ' + errMsg(e); }
  state.loading = false; render();
}
let eventSource = null;
function subscribe() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = async e => {
    if (e.data !== 'change' || !me || state.loading) return;
    const before = Orders.cache.slice();
    try {
      await Promise.all([Orders.load(), Products.load(), Notifs.load()]);
      const doneBefore = new Set(before.filter(o => o.status === 'done').map(o => String(o.id)));
      const doneNow = Orders.cache.find(o => o.status === 'done' && !doneBefore.has(String(o.id)));
      const newNow = Orders.cache.find(o => !before.some(b => String(b.id) === String(o.id)));
      if (newNow) toast('🔔 Nová objednávka #' + newNow.number, 5000);
      if (doneNow) toast('🔔 Objednávka #' + doneNow.number + ' byla dokončena', 5000);
      render();
    } catch (err) { console.error(err); }
  };
  eventSource.onerror = () => { /* browser EventSource se automaticky pokusí připojit znovu */ };
}
async function applySession(activeMe) {
  if (!activeMe) {
    if (eventSource) { eventSource.close(); eventSource = null; }
    Orders.cache = []; Products.cache = []; Notifs.cache = []; me = null; Auth.id = null; state = { view: 'dashboard', f: {} }; closeModal();
    $('#app').hidden = true; $('#login').hidden = false; return;
  }
  me = userFor(activeMe); Auth.id = me.id;
  $('#login').hidden = true; $('#app').hidden = false;
  await loadData(); subscribe();
}
async function boot() {
  loadPublicStats();
  setInterval(loadPublicStats, 60000);
  try {
    const active = await api('/api/me');
    await applySession(active);
  } catch (_) {
    applySession(null);
  }
}

const actions = {
  nav: d => { state.view = d.v; render(); window.scrollTo(0, 0); },
  menu: () => $('#app').classList.toggle('open'),
  logout: () => run('Odhlášení se nezdařilo.', async () => { await Auth.logout(); await applySession(null); }),
  reload: () => loadData(),
  new: () => orderForm(),
  open: d => orderDetail(d.id),
  close: closeModal,
  closeBg: (d, e) => { if (e.target.classList.contains('modal')) closeModal(); },
  status: d => run('Stav se nepodařilo změnit.', async () => {
    if (d.s === 'cancelled') await Orders.update(d.id, { status: 'cancelled' });
    else { await api(`/api/production/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { id: d.id, status: d.s } }); await loadData(); }
    closeModal(); render(); toast('Stav změněn: ' + CONFIG.statuses[d.s][1]);
  }),
  delOrder: d => { if (confirm('Opravdu smazat objednávku?')) run('Objednávku se nepodařilo smazat.', async () => { await Orders.remove(d.id); closeModal(); render(); toast('Objednávka smazána'); }); },
  prodForm: d => prodForm(d.id),
  delProd: d => { if (confirm('Smazat produkt?')) run('Produkt se nepodařilo smazat.', async () => { await Products.remove(d.id); render(); toast('Produkt smazán'); }); },
  clearDemo: () => run('Demo data se nepodařilo odstranit.', async () => { const demo = Products.cache.filter(p => p.demo); for (const p of demo) await Products.remove(p.id); render(); toast('Demo data odstraněna'); }),
  export: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ orders: orders(), products: products(), notifs: myNotifs() }, null, 2)], { type: 'application/json' })); a.download = 'zabaleno-zaloha.json'; a.click(); },
  resetAll: () => { if (confirm('Lokální data nejsou používána. Data v Google Sheets zůstanou beze změny.')) toast('Data v Google Sheets nebyla změněna.'); }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || !actions[el.dataset.act]) return;
  actions[el.dataset.act](el.dataset, e);
});

document.addEventListener('input', e => {
  if (e.target.form && e.target.form.id === 'orderForm') calcForm(['productId'].includes(e.target.name));
  if (e.target.dataset.f !== undefined) {
    const k = e.target.dataset.f, pos = e.target.selectionStart; state.f[k] = e.target.value; render();
    const n = document.querySelector(`[data-f="${k}"]`); if (n && k === 'q') { n.focus(); n.setSelectionRange(pos, pos); }
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  if (f.id === 'loginForm') {
    const d = new FormData(f), btn = f.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Přihlašuji…'; showLoginError('');
    try { const active = await Auth.login(d.get('email'), d.get('pass'), d.get('remember')); await applySession(active.me); f.reset(); }
    catch (err) { showLoginError(/Nesprávný email nebo heslo/i.test(err.message) ? 'Nesprávný email nebo heslo.' : 'Přihlášení se nezdařilo: ' + errMsg(err)); }
    btn.disabled = false; btn.textContent = 'Přihlásit se';
  }
  if (f.id === 'orderForm') {
    if (state.busy) return;
    const x = f.elements, btn = f.querySelector('[type=submit]'), id = crypto.randomUUID();
    const p = prod(x.productId.value);
    const row = { id, num: nextId(), date: new Date(x.date.value + 'T' + new Date().toTimeString().slice(0, 8)).toISOString(),
      customer: x.customer.value, contact: x.contact.value, productId: x.productId.value, variant: x.variant.value,
      note: x.note.value, status: 'new', due: x.due.value || '', items: [{ pid: p.id || null, pname: x.productId.value, qty: +x.qty.value, price: +x.unitPrice.value, cost: (+x.cost.value || 0) / (+x.qty.value || 1), my: 0, partner: 0, vars: { variant: x.variant.value } }] };
    btn.disabled = true; btn.textContent = 'Ukládám…';
    await run('Objednávku se nepodařilo vytvořit.', async () => { const o = await Orders.insert(row); closeModal(); state.view = 'orders'; render(); toast('Objednávka #' + (o?.number || row.num) + ' vytvořena'); });
    if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Uložit objednávku'; }
  }
  if (f.id === 'prodForm') {
    const x = f.elements, id = f.dataset.id || 'p' + Date.now(), old = products().find(p => p.id === id), img = await shrink(x.image.files[0]);
    const p = { id, name: x.name.value, size: x.size.value, weight: +x.weight.value, hours: +x.hours.value, matPerKg: +x.matPerKg.value,
      hourRate: +x.hourRate.value, price: +x.price.value, image: img || (old ? old.image : ''), demo: old && old.demo };
    await run('Produkt se nepodařilo uložit.', async () => { await Products.save(p); closeModal(); render(); toast('Produkt uložen'); });
  }
});

boot();
})();
