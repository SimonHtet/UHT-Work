/* ── IndexedDB helpers ──────────────────────────────────────────────────────── */

const IDB_NAME = 'uht-filling';
const IDB_VER  = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };

    req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
    req.onerror    = e => reject(e.target.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).put(value);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

// ── Cache key/value wrappers ─────────────────────────────────────────────────
async function cacheSet(key, value) { await idbPut('cache', { key, value }); }
async function cacheGet(key) {
  const row = await idbGet('cache', key);
  return row ? row.value : null;
}

/* ── App state ──────────────────────────────────────────────────────────────── */

let session       = null;   // { operatorId, username, machineName }
let setupData     = null;   // { productDate, productId, flavor, startingBrik }
let currentSlots  = [];     // array of { barcode, depositing, opt, supplier }
let slotIndex     = 0;      // 0-based index of the slot currently being entered

/* ── Utilities ──────────────────────────────────────────────────────────────── */

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function el(id) { return document.getElementById(id); }

// ── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, type = '', ms = 3500) {
  const t = el('toast');
  t.textContent = msg;
  t.className   = `toast ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, ms);
}

// ── Screen navigation ────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  const target = el(id);
  target.classList.remove('hidden');
  target.classList.add('active');
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */

(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }

  const stored = localStorage.getItem('session');
  if (stored) {
    try { session = JSON.parse(stored); } catch { session = null; }
  }

  if (session) {
    showScreen('screen-setup');
    await loadSetupScreen();
  } else {
    showScreen('screen-login');
  }
})();

/* ══════════════════════════════════════════════════════════════════════════════
   SCREEN 1 — LOGIN
══════════════════════════════════════════════════════════════════════════════ */

el('btn-login').addEventListener('click', doLogin);
el('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
el('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') el('login-password').focus(); });

async function doLogin() {
  const username = el('login-username').value.trim();
  const password = el('login-password').value;
  const errEl    = el('login-error');
  errEl.classList.add('hidden');

  if (!username || !password) {
    errEl.textContent = 'Enter username and password.';
    errEl.classList.remove('hidden');
    return;
  }

  const btn = el('btn-login');
  btn.disabled    = true;
  btn.textContent = 'Logging in…';

  try {
    const resp = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
      signal:  AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'Invalid credentials');
    }

    const data = await resp.json();
    session = { operatorId: data.operatorId, username: data.username, machineName: data.machineName };
    localStorage.setItem('session', JSON.stringify(session));

    // Pre-fetch and cache immediately after login
    await Promise.all([
      fetchAndCacheProducts(session.machineName),
      fetchAndCacheMachineStatus(session.machineName, todayISO()),
    ]);

    showScreen('screen-setup');
    await loadSetupScreen();

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'TypeError') {
      errEl.textContent = 'Server offline — cannot login.';
    } else {
      errEl.textContent = err.message || 'Login failed.';
    }
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Login';
  }
}

async function fetchAndCacheProducts(machine) {
  try {
    const resp = await fetch(`/api/products?machine=${encodeURIComponent(machine)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return;
    const products = await resp.json();
    await cacheSet(`products:${machine}`, products);
    for (const p of products) {
      await cacheSet(`flavor:${p.Product_ID}`, p.Flavor);
    }
  } catch { /* offline — rely on existing cache */ }
}

async function fetchAndCacheMachineStatus(machine, date) {
  try {
    const resp = await fetch(
      `/api/machine-status?machine=${encodeURIComponent(machine)}&date=${encodeURIComponent(date)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return;
    const status = await resp.json();
    await cacheSet(`machine-status:${machine}:${date}`, status);
    if (status && status.Product_ID) {
      await cacheSet(`last-product:${machine}`, status.Product_ID);
    }
  } catch { /* offline */ }
}

/* ══════════════════════════════════════════════════════════════════════════════
   SCREEN 2 — SESSION SETUP
══════════════════════════════════════════════════════════════════════════════ */

el('btn-logout').addEventListener('click', () => {
  if (!confirm('Logout? Any unfinished scanning will be lost.')) return;
  localStorage.removeItem('session');
  session    = null;
  setupData  = null;
  currentSlots = [];
  slotIndex    = 0;
  el('login-username').value = '';
  el('login-password').value = '';
  el('login-error').classList.add('hidden');
  showScreen('screen-login');
});

el('btn-go-sync').addEventListener('click', () => {
  showScreen('screen-sync');
  loadSyncScreen();
});

el('setup-date').addEventListener('change', async () => {
  const date = el('setup-date').value;
  await fetchAndCacheMachineStatus(session.machineName, date);
  await renderBrikGrid();
});

el('setup-starting-brik').addEventListener('input', () => renderBrikGrid(true));

el('btn-start-scanning').addEventListener('click', () => {
  const productId    = el('setup-product').value;
  const flavor       = el('setup-flavor').value;
  const productDate  = el('setup-date').value;
  const startingBrik = parseInt(el('setup-starting-brik').value);

  if (!productId) {
    showToast('Select a Product ID first.', 'error');
    return;
  }
  if (!productDate) {
    showToast('Set a Product Date.', 'error');
    return;
  }
  if (!startingBrik || startingBrik < 1 || startingBrik > 40) {
    showToast('Starting Brik must be between 1 and 40.', 'error');
    return;
  }

  setupData    = { productDate, productId, flavor, startingBrik };
  currentSlots = [];
  slotIndex    = 0;

  showScreen('screen-scanning');
  loadScanningScreen();
});

async function loadSetupScreen() {
  el('setup-operator-info').textContent = `${session.username} · ${session.machineName}`;
  el('setup-machine').value = session.machineName;

  if (!el('setup-date').value) {
    el('setup-date').value = todayISO();
  }

  const lastProduct = await cacheGet(`last-product:${session.machineName}`);
  if (lastProduct) {
    el('setup-product').value = lastProduct;
    const flavor = await cacheGet(`flavor:${lastProduct}`);
    el('setup-flavor').value = flavor || '';
  }

  await renderBrikGrid();
}

async function renderBrikGrid(skipAutoDetect = false) {
  const date   = el('setup-date').value || todayISO();
  const status = await cacheGet(`machine-status:${session.machineName}:${date}`);

  // Auto-detect first empty brik (runs on the first call only)
  if (!skipAutoDetect) {
    let firstEmpty = null;
    for (let i = 1; i <= 40; i++) {
      const val = status && status[`Barcode ${i}`];
      if (!val || String(val).trim() === '') { firstEmpty = i; break; }
    }
    if (firstEmpty === null) {
      el('setup-starting-brik').value = 40;
      showToast('All briks already filled for this date!', 'error', 5000);
    } else {
      el('setup-starting-brik').value = firstEmpty;
    }
  }

  const startingBrik = parseInt(el('setup-starting-brik').value) || 1;
  const grid = el('brik-status-grid');
  grid.innerHTML = '';

  for (let i = 1; i <= 40; i++) {
    const cell = document.createElement('div');
    cell.className   = 'brik-cell';
    cell.textContent = i;

    const barcodeValue = status && status[`Barcode ${i}`];
    if (barcodeValue && String(barcodeValue).trim() !== '') {
      cell.classList.add('filled');
    } else if (i === startingBrik) {
      cell.classList.add('starting');
    }

    grid.appendChild(cell);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   SCREEN 3 — SLOT ENTRY (SCANNING)
══════════════════════════════════════════════════════════════════════════════ */

function loadScanningScreen() {
  updateScanUI();
  clearSlotForm();
  renderCompletedList();
}

function updateScanUI() {
  const currentBrik  = setupData.startingBrik + slotIndex;
  const totalBriks   = 40;
  const slotsTotal   = totalBriks - setupData.startingBrik + 1;
  const pct          = Math.round((currentSlots.length / slotsTotal) * 100);

  el('scan-brik-label').textContent  = `Brik ${currentBrik} of ${totalBriks}`;
  el('scan-session-info').textContent =
    `${setupData.productId} · ${setupData.flavor} · ${setupData.productDate}`;
  el('scan-progress-bar').style.width = `${pct}%`;
}

function clearSlotForm() {
  el('scan-barcode').value    = '';
  el('scan-depositing').value = '';
  el('scan-opt').value        = '';
  el('scan-supplier').value   = '';
  el('btn-add-brik').disabled = true;
  el('scan-barcode').focus();
}

// Enable "Add" button only when all four fields have values
function checkSlotReady() {
  const ok = el('scan-barcode').value.trim()    !== '' &&
             el('scan-depositing').value.trim() !== '' &&
             el('scan-opt').value.trim()        !== '' &&
             el('scan-supplier').value.trim()   !== '';
  el('btn-add-brik').disabled = !ok;
}

['scan-barcode', 'scan-opt', 'scan-supplier']
  .forEach(id => el(id).addEventListener('input', checkSlotReady));

el('scan-depositing').addEventListener('change', checkSlotReady);

// Barcode scanner fires Enter after the code — advance focus to depositing select
el('scan-barcode').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el('scan-depositing').focus();
  }
});

// L/R keyboard shortcuts on the depositing select for fast entry
el('scan-depositing').addEventListener('keydown', e => {
  if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    el('scan-depositing').value = 'L';
    checkSlotReady();
    el('scan-opt').focus();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    el('scan-depositing').value = 'R';
    checkSlotReady();
    el('scan-opt').focus();
  }
});

el('btn-add-brik').addEventListener('click', addBrik);

function addBrik() {
  const barcode    = el('scan-barcode').value.trim();
  const depositing = el('scan-depositing').value.trim();
  const opt        = parseInt(el('scan-opt').value, 10);
  const supplier   = parseInt(el('scan-supplier').value, 10);

  if (!barcode || !depositing || isNaN(opt) || isNaN(supplier)) return;

  currentSlots.push({ barcode, depositing, opt, supplier });
  slotIndex++;

  const nextBrik = setupData.startingBrik + slotIndex;

  if (nextBrik > 40) {
    showToast('All 40 briks filled — press Finish & Save.', 'success', 5000);
    el('btn-add-brik').disabled = true;
    updateScanUI();
    renderCompletedList();
    return;
  }

  clearSlotForm();
  updateScanUI();
  renderCompletedList();
}

function renderCompletedList() {
  const container = el('completed-list');
  container.innerHTML = '';

  if (currentSlots.length === 0) {
    container.innerHTML = '<p class="empty-state">No briks added yet.</p>';
    return;
  }

  currentSlots.forEach((slot, i) => {
    const brikNum = setupData.startingBrik + i;
    const isLast  = i === currentSlots.length - 1;

    const item = document.createElement('div');
    item.className = 'completed-item';
    item.innerHTML = `
      <div class="completed-item-info">
        <strong>Brik ${brikNum}</strong>
        <small>${slot.barcode} &nbsp;|&nbsp; Dep: ${slot.depositing} &nbsp;|&nbsp; OPT: ${slot.opt} &nbsp;|&nbsp; Sup: ${slot.supplier}</small>
      </div>
      ${isLast ? `<button class="btn btn-danger" onclick="deleteLastBrik()" aria-label="Delete last brik">Del</button>` : ''}
    `;
    container.appendChild(item);
  });

  // Scroll last entry into view
  container.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function deleteLastBrik() {
  if (currentSlots.length === 0) return;
  currentSlots.pop();
  slotIndex--;
  clearSlotForm();
  updateScanUI();
  renderCompletedList();
}

el('btn-finish-save').addEventListener('click', async () => {
  if (currentSlots.length === 0) {
    showToast('No briks to save.', 'error');
    return;
  }

  const btn = el('btn-finish-save');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  const record = {
    operatorId:   session.operatorId,
    machineName:  session.machineName,
    productId:    setupData.productId,
    flavor:       setupData.flavor,
    productDate:  setupData.productDate,
    startingBrik: setupData.startingBrik,
    slots:        [...currentSlots],
    status:       'pending',
    createdAt:    new Date().toISOString(),
  };

  try {
    await idbPut('sessions', record);
    showToast(`${currentSlots.length} brik(s) saved locally. Go to Sync Queue to upload.`, 'success', 5000);
    currentSlots = [];
    slotIndex    = 0;
    setupData    = null;
    showScreen('screen-setup');
    await loadSetupScreen();
  } catch (err) {
    showToast('Failed to save session to local storage.', 'error');
    console.error(err);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Finish & Save Session';
  }
});

el('btn-back-to-setup').addEventListener('click', () => {
  if (currentSlots.length > 0) {
    if (!confirm(`Go back? ${currentSlots.length} brik(s) in progress will be lost.`)) return;
  }
  currentSlots = [];
  slotIndex    = 0;
  showScreen('screen-setup');
});

/* ══════════════════════════════════════════════════════════════════════════════
   SCREEN 4 — SYNC QUEUE
══════════════════════════════════════════════════════════════════════════════ */

let _pollTimer  = null;
let _wasOnline  = null;

async function loadSyncScreen() {
  await renderSessionsList();
  startPolling();
}

function startPolling() {
  clearInterval(_pollTimer);
  checkOnline();
  _pollTimer = setInterval(checkOnline, 10_000);
}

function stopPolling() {
  clearInterval(_pollTimer);
  _pollTimer = null;
  _wasOnline = null;
}

async function checkOnline() {
  let online = false;
  try {
    const resp = await fetch('/api/pending-check', { signal: AbortSignal.timeout(3000) });
    online = resp.ok;
  } catch { /* offline */ }

  // Transition: offline → online
  if (_wasOnline === false && online) {
    showToast("Back online — don't forget to sync!", 'success', 5000);
  }
  _wasOnline = online;

  el('online-dot').className   = `dot ${online ? 'dot-online' : 'dot-offline'}`;
  el('online-label').textContent = online ? 'Online' : 'Offline';
  el('btn-sync-all').disabled  = !online;
}

async function renderSessionsList() {
  const all       = await idbGetAll('sessions');
  const container = el('sessions-list');

  if (all.length === 0) {
    container.innerHTML = '<p class="empty-state">No sessions in the queue.</p>';
    return;
  }

  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  container.innerHTML = all.map(s => `
    <div class="session-card status-${s.status}">
      <div class="session-card-header">
        <h4>${s.productId} &mdash; ${s.machineName}</h4>
        <span class="status-badge badge-${s.status}">${s.status}</span>
      </div>
      <p class="meta">
        ${s.productDate} &nbsp;&bull;&nbsp; ${s.slots.length} brik(s) from Brik ${s.startingBrik}
        &nbsp;&bull;&nbsp; ${s.flavor || '—'}
      </p>
      <p class="meta" style="font-size:0.78rem;margin-top:4px;color:var(--grey-500)">
        Saved ${new Date(s.createdAt).toLocaleString()}
      </p>
      ${s.status === 'error'
        ? `<button class="btn btn-secondary" style="margin-top:10px;height:42px;font-size:0.82rem;"
               onclick="retrySession(${s.id})">Retry Upload</button>`
        : ''}
    </div>
  `).join('');
}

el('btn-sync-all').addEventListener('click', syncAll);

async function syncAll() {
  const pending = (await idbGetAll('sessions')).filter(s => s.status === 'pending');
  if (pending.length === 0) {
    showToast('Nothing to sync.', '');
    return;
  }

  const btn = el('btn-sync-all');
  btn.disabled    = true;
  btn.textContent = 'Syncing…';

  let ok = 0, fail = 0;

  for (const s of pending) {
    const success = await submitSession(s);
    s.status = success ? 'synced' : 'error';
    await idbPut('sessions', s);
    ok   += success ? 1 : 0;
    fail += success ? 0 : 1;
    await renderSessionsList();
  }

  btn.textContent = 'Sync to Server';
  await checkOnline();

  if (fail === 0) {
    showToast(`All ${ok} session(s) synced successfully!`, 'success', 5000);
  } else {
    showToast(`${ok} synced, ${fail} failed. Tap Retry to retry.`, 'error', 5000);
  }
}

async function retrySession(id) {
  const s = await idbGet('sessions', id);
  if (!s) return;
  const success = await submitSession(s);
  s.status = success ? 'synced' : 'error';
  await idbPut('sessions', s);
  await renderSessionsList();
  showToast(success ? 'Session synced!' : 'Sync failed — try again.', success ? 'success' : 'error');
}

async function submitSession(s) {
  try {
    const resp = await fetch('/api/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId:   s.operatorId,
        machineName:  s.machineName,
        productId:    s.productId,
        flavor:       s.flavor,
        productDate:  s.productDate,
        startingBrik: s.startingBrik,
        slots:        s.slots,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

el('btn-back-to-setup2').addEventListener('click', async () => {
  stopPolling();
  showScreen('screen-setup');
  await loadSetupScreen();
});
