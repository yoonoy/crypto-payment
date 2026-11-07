const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const state = {
  auth: false,
  client: load('client', null),
  pays: load('pays', []),
  data: {},
  clients: [],
  chooseClient: false,
};
const ACTIVE = ['PENDING', 'CONFIRMING', 'REFUND_PENDING'];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 3500);
}

async function api(method, path, body) {
  const r = await fetch('/web' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && state.auth) { state.auth = false; showLogin(); }
  if (!r.ok) throw new Error(j.error?.message || 'Ошибка ' + r.status);
  return j;
}

const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function renderClient() {
  const c = state.client;
  $('#clientBox').innerHTML = c
    ? `<div class="mu">${esc(c.name)} · ${esc(c.email)}</div>
       <div class="bal">${esc(c.balance)} ETH</div>
       <div class="mu">id: ${esc(c.id)}</div>
       <button class="ghost refresh-balance" id="refreshBal">Обновить баланс</button>
       <button class="ghost" id="anotherClient">Другой клиент</button>
       <div id="clientChoices"></div>`
    : `<label for="cName">Имя</label><input id="cName">
       <label for="cMail">Email</label><input id="cMail" type="email">
       <button id="createClient">Создать клиента</button>
       <button class="ghost client-select" id="anotherClient">Выбрать клиента</button>
       <div id="clientChoices"></div>`;
  $('#anotherClient').onclick = run(toggleClientChoices);
  if (c) {
    $('#refreshBal').onclick = run(refreshClient);
  } else {
    $('#createClient').onclick = run(async () => {
      state.client = await api('POST', '/clients', { name: $('#cName').value, email: $('#cMail').value });
      save('client', state.client); state.chooseClient = false; renderClient();
    });
  }
  renderClientChoices();
}

async function toggleClientChoices() {
  if (state.chooseClient) {
    state.chooseClient = false;
    renderClient();
    return;
  }
  state.clients = await api('GET', '/clients');
  state.chooseClient = true;
  renderClient();
}

function renderClientChoices() {
  const box = $('#clientChoices');
  if (!state.chooseClient) { box.innerHTML = ''; return; }
  if (!state.clients.length) {
    box.innerHTML = '<p class="mu">Клиентов пока нет.</p>';
    return;
  }
  box.innerHTML = state.clients.map((client) =>
    `<button data-client="${esc(client.id)}">${esc(client.name)} · ${esc(client.email)} · ${esc(client.balance)} ETH</button>`
  ).join('');
  box.querySelectorAll('[data-client]').forEach((button) => {
    button.onclick = run(() => selectClient(button.dataset.client));
  });
}

async function selectClient(id) {
  state.client = await api('GET', '/clients/' + id);
  state.pays = [];
  state.data = {};
  state.chooseClient = false;
  save('client', state.client);
  save('pays', state.pays);
  renderClient();
  renderList();
}

async function refreshClient() {
  if (!state.client) return;
  state.client = await api('GET', '/clients/' + state.client.id);
  save('client', state.client); renderClient();
}

function renderList() {
  const box = $('#list');
  if (!state.pays.length) { box.innerHTML = '<p class="mu">Пока пусто.</p>'; return; }
  box.innerHTML = state.pays.map((id) => {
    const p = state.data[id];
    if (!p) return `<div class="pay mu">Загрузка ${esc(id)}…</div>`;
    const kind = p.purpose === 'TOPUP' ? 'Пополнение' : p.method === 'BALANCE' ? 'Оплата с баланса' : 'Оплата криптой';
    const showAddr = p.method === 'CRYPTO' && p.status === 'PENDING';
    const canRefund = p.purpose === 'PURCHASE' && p.status === 'COMPLETED';
    return `<div class="pay">
      <div class="row"><b>${kind}: ${esc(p.amount)} ETH</b><span class="badge ${p.status}">${p.status}</span></div>
      <div class="mu">${esc(p.id)}</div>
      ${showAddr ? `<div class="mu payment-address-hint">Отправь ровно ${esc(p.amount)} ETH (Sepolia) на адрес:</div><div class="addr">${esc(p.address)}</div>` : ''}
      ${p.refund_tx_hash ? `<div class="addr">refund tx: ${esc(p.refund_tx_hash)}</div>` : ''}
      ${canRefund ? `<div class="refund-action"><button class="ghost" data-refund="${esc(p.id)}">Сделать возврат</button></div>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = run(() => refund(b.dataset.refund))));
}

async function refund(id) {
  const p = state.data[id];
  let body = {};
  if (p.method === 'CRYPTO') {
    const a = prompt('Адрес ETH, куда вернуть деньги (0x...):');
    if (!a) return;
    body = { refund_address: a.trim() };
  }
  state.data[id] = await api('POST', `/payments/${id}/refund`, body);
  renderList(); refreshClient().catch(() => {});
  toast('Возврат выполнен');
}

async function refreshPayments() {
  let changed = false;
  for (const id of state.pays) {
    const old = state.data[id];
    if (old && !ACTIVE.includes(old.status)) continue;
    try {
      const p = await api('GET', '/payments/' + id);
      if (!old || old.status !== p.status) changed = true;
      state.data[id] = p;
    } catch {}
  }
  if (changed) { renderList(); refreshClient().catch(() => {}); }
}

function addPayment(p) {
  state.data[p.id] = p;
  if (!state.pays.includes(p.id)) state.pays.unshift(p.id);
  save('pays', state.pays); renderList();
}

const needClient = () => { if (!state.client) throw new Error('Сначала создай клиента'); };
const amt = (sel) => $(sel).value.trim().replace(',', '.');
const newKey = () => crypto.randomUUID();

function showLogin() {
  $('#loginScreen').hidden = false;
  $('main').hidden = true;
}

function showApp() {
  $('#loginScreen').hidden = true;
  $('main').hidden = false;
  renderClient();
  renderList();
}

async function login() {
  await api('POST', '/login', { password: $('#pw').value });
  state.auth = true;
  showApp();
  refreshPayments();
  if (state.client) refreshClient().catch(() => {});
}

$('#loginBtn').onclick = run(login);
$('#pw').onkeydown = (e) => { if (e.key === 'Enter') $('#loginBtn').click(); };

$('#logoutSite').onclick = run(async () => {
  await api('POST', '/logout');
  state.auth = false;
  showLogin();
});

$('#topBtn').onclick = run(async () => {
  needClient();
  addPayment(await api('POST', `/clients/${state.client.id}/topups`, { amount: amt('#topAmt'), idempotency_key: newKey() }));
});
$('#balBtn').onclick = run(async () => {
  needClient();
  addPayment(await api('POST', '/payments', { client_id: state.client.id, amount: amt('#balAmt'), method: 'BALANCE', idempotency_key: newKey() }));
  await refreshClient();
});
$('#cryBtn').onclick = run(async () => {
  needClient();
  addPayment(await api('POST', '/payments', { client_id: state.client.id, amount: amt('#cryAmt'), method: 'CRYPTO', idempotency_key: newKey() }));
});

localStorage.removeItem('key'); // ключ в браузере больше не используется
showLogin();
api('GET', '/session').then(() => {
  state.auth = true;
  showApp();
  refreshPayments();
  if (state.client) refreshClient().catch(() => {});
}).catch(() => {});
setInterval(() => { if (state.auth) refreshPayments(); }, 5000);
