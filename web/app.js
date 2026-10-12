'use strict';

/**
 * StackDrive — panel mínimo de prueba.
 *
 * JS plano, sin dependencias ni build: el objetivo es ejercitar de principio
 * a fin el flujo de la API (login, vinculación multi-cuenta, exploración,
 * subida/descarga, vista agregada, redistribución y transferencias), no ser
 * un panel de producción.
 *
 * El JWT y el refresh token de StackDrive se guardan en localStorage por
 * comodidad de desarrollo (sobreviven a recargar la página). Para un panel
 * real de producción convendría moverlos a una cookie httpOnly; aquí se
 * acepta el trade-off porque esto solo habla con un backend local.
 */

const STORAGE_KEY = 'stackdrive.panel.v1';

const state = {
  apiBase: localStorage.getItem('stackdrive.apiBase') || 'http://localhost:3000',
  accessToken: null,
  refreshToken: null,
  user: null,
  accounts: [],
  explorer: { accountId: null, stack: [{ id: 'root', name: 'Mi unidad' }] },
  transfersPoll: null,
};

// ─────────────────────────── utilidades generales ───────────────────────────

function $(selector, root = document) {
  return root.querySelector(selector);
}
function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function toast(message, type = 'ok') {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ─────────────────────────── cliente HTTP de la API ─────────────────────────

/**
 * Llama a la API con el JWT actual. Si la respuesta es 401 por token
 * caducado, intenta renovarlo UNA vez con el refresh token y repite la
 * petición original; si eso también falla, cierra la sesión del panel.
 */
async function api(path, options = {}) {
  const run = async () => {
    const headers = { ...(options.headers || {}) };
    if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;

    const response = await fetch(`${state.apiBase}${path}`, { ...options, headers });
    return response;
  };

  let response = await run();

  if (response.status === 401 && state.refreshToken && path !== '/auth/refresh') {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      response = await run();
    }
  }

  if (!response.ok) {
    let body = null;
    try { body = await response.json(); } catch { /* respuesta sin cuerpo JSON */ }
    const message = body?.message || body?.detail || `Error HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : response;
}

async function tryRefreshToken() {
  try {
    const result = await fetch(`${state.apiBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    if (!result.ok) throw new Error('refresh falló');
    const tokens = await result.json();
    setSession(tokens);
    return true;
  } catch {
    clearSession();
    return false;
  }
}

// ─────────────────────────── sesión ──────────────────────────────────────────

function setSession(tokens) {
  state.accessToken = tokens.accessToken;
  state.refreshToken = tokens.refreshToken;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  }));
  document.body.classList.add('authenticated');
}

function clearSession() {
  state.accessToken = null;
  state.refreshToken = null;
  state.user = null;
  localStorage.removeItem(STORAGE_KEY);
  document.body.classList.remove('authenticated');
  stopTransfersPoll();
}

async function restoreSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const stored = JSON.parse(raw);
    state.accessToken = stored.accessToken;
    state.refreshToken = stored.refreshToken;
    state.user = await api('/auth/me');
    document.body.classList.add('authenticated');
    $('#session-email').textContent = state.user.email;
    await loadAccounts();
  } catch {
    clearSession();
  }
}

// ─────────────────────────── pestañas ────────────────────────────────────────

function showView(name) {
  $all('section.view[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  $all('nav.tabs button[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  if (name === 'transfers') startTransfersPoll(); else stopTransfersPoll();
}

$all('nav.tabs button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ─────────────────────────── API base ────────────────────────────────────────

$('#api-base-input').value = state.apiBase;
$('#api-base-save').addEventListener('click', () => {
  state.apiBase = $('#api-base-input').value.trim().replace(/\/$/, '');
  localStorage.setItem('stackdrive.apiBase', state.apiBase);
  toast(`API configurada en ${state.apiBase}`);
});

// ─────────────────────────── formulario de sesión ────────────────────────────

let authMode = 'login'; // 'login' | 'register'

$('#auth-toggle').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  $('#auth-mode-title').textContent = authMode === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
  $('#auth-submit').textContent = authMode === 'login' ? 'Entrar' : 'Registrarme';
  $('#auth-toggle').textContent = authMode === 'login'
    ? '¿No tienes cuenta? Regístrate'
    : '¿Ya tienes cuenta? Inicia sesión';
  $('#display-name-field').style.display = authMode === 'register' ? '' : 'none';
});

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;

  try {
    const tokens = authMode === 'login'
      ? await api('/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
      : await api('/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, displayName: $('#auth-display-name').value.trim() || undefined }),
        });

    setSession(tokens);
    state.user = await api('/auth/me');
    $('#session-email').textContent = state.user.email;
    toast(authMode === 'login' ? 'Sesión iniciada' : 'Cuenta creada');
    await loadAccounts();
    showView('accounts');
  } catch (error) {
    toast(error.message, 'error');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    if (state.refreshToken) {
      await api('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
    }
  } catch { /* si ya estaba caducado, igualmente limpiamos el panel */ }
  clearSession();
  toast('Sesión cerrada');
});

// ─────────────────────────── vinculación de cuentas ──────────────────────────

$('#link-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/google/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alias: $('#link-alias').value.trim() || undefined,
        loginHint: $('#link-hint').value.trim() || undefined,
        redirectTo: window.location.origin + window.location.pathname,
      }),
    });
    // Se abre en una pestaña nueva: el consentimiento de Google y el callback
    // ocurren fuera del panel, que recupera el resultado por query string al
    // volver (ver handleOAuthRedirect).
    window.open(result.authUrl, '_blank', 'noopener');
    toast('Completa el consentimiento en la pestaña nueva; esta tabla se actualizará sola.');
    pollAccountsUntilChange();
  } catch (error) {
    toast(error.message, 'error');
  }
});

/** Tras abrir la pestaña de Google, sondea las cuentas unos segundos. */
function pollAccountsUntilChange() {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts += 1;
    await loadAccounts();
    if (attempts >= 20) clearInterval(interval); // ~1 minuto de margen
  }, 3000);
}

function accountStatusBadge(account) {
  if (account.status === 'ACTIVE') return '<span class="badge ok">Activa</span>';
  if (account.status === 'NEEDS_REAUTH') return '<span class="badge warn">Necesita reautorizar</span>';
  return '<span class="badge danger">Desvinculada</span>';
}

async function loadAccounts() {
  try {
    state.accounts = await api('/accounts');
  } catch (error) {
    toast(error.message, 'error');
    return;
  }

  const tbody = $('#accounts-table tbody');
  tbody.innerHTML = state.accounts.map((account) => `
    <tr data-id="${account.id}">
      <td>${escapeHtml(account.email)}</td>
      <td>${escapeHtml(account.alias ?? '—')}</td>
      <td>${accountStatusBadge(account)}</td>
      <td class="muted">${formatDate(account.linkedAt)}</td>
      <td class="actions-cell">
        ${account.needsReauth ? '<button class="small reauth-btn">Reautorizar</button>' : ''}
        <button class="small rename-btn">Alias</button>
        <button class="small danger unlink-btn">Desvincular</button>
      </td>
    </tr>
  `).join('');

  $('#accounts-empty').style.display = state.accounts.length === 0 ? '' : 'none';

  $all('.reauth-btn', tbody).forEach((btn) => {
    const id = btn.closest('tr').dataset.id;
    btn.addEventListener('click', async () => {
      try {
        const result = await api(`/accounts/${id}/reauth`, { method: 'POST' });
        window.open(result.authUrl, '_blank', 'noopener');
        pollAccountsUntilChange();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  $all('.rename-btn', tbody).forEach((btn) => {
    const id = btn.closest('tr').dataset.id;
    btn.addEventListener('click', async () => {
      const current = state.accounts.find((a) => a.id === id);
      const alias = window.prompt('Nuevo alias para esta cuenta:', current?.alias ?? '');
      if (alias === null) return;
      try {
        await api(`/accounts/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alias }),
        });
        await loadAccounts();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  $all('.unlink-btn', tbody).forEach((btn) => {
    const id = btn.closest('tr').dataset.id;
    btn.addEventListener('click', async () => {
      const account = state.accounts.find((a) => a.id === id);
      if (!window.confirm(`¿Desvincular ${account?.email}? Se revocará el acceso en Google.`)) return;
      try {
        await api(`/accounts/${id}`, { method: 'DELETE' });
        toast('Cuenta desvinculada');
        await loadAccounts();
        populateAccountSelects();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  populateAccountSelects();
}

$('#accounts-refresh').addEventListener('click', loadAccounts);

function activeAccounts() {
  return state.accounts.filter((a) => a.status === 'ACTIVE');
}

function populateAccountSelects() {
  const options = activeAccounts()
    .map((a) => `<option value="${a.id}">${escapeHtml(a.alias || a.email)}</option>`)
    .join('');

  const explorerSelect = $('#explorer-account');
  const previous = explorerSelect.value;
  explorerSelect.innerHTML = options || '<option value="">(sin cuentas activas)</option>';
  if (previous && activeAccounts().some((a) => a.id === previous)) {
    explorerSelect.value = previous;
  } else if (explorerSelect.options.length) {
    state.explorer.accountId = explorerSelect.value || null;
    state.explorer.stack = [{ id: 'root', name: 'Mi unidad' }];
  }

  $('#transfer-dialog-account').innerHTML = options;
}

/** Recoge `status`/`accountId`/`email`/`reason` que deja el callback de Google. */
function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('status')) return;

  if (params.get('status') === 'linked') {
    toast(`Cuenta vinculada: ${params.get('email')}${params.get('relinked') === 'true' ? ' (reautorizada)' : ''}`);
  } else if (params.get('status') === 'error') {
    toast(`La vinculación no se completó: ${params.get('reason') || 'error desconocido'}`, 'error');
  }

  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}

// ─────────────────────────── explorador (una cuenta) ─────────────────────────

$('#explorer-account').addEventListener('change', (event) => {
  state.explorer.accountId = event.target.value || null;
  state.explorer.stack = [{ id: 'root', name: 'Mi unidad' }];
  loadExplorer();
});

function currentFolder() {
  return state.explorer.stack[state.explorer.stack.length - 1];
}

function renderBreadcrumbs() {
  $('#explorer-breadcrumbs').innerHTML = state.explorer.stack.map((item, index) => `
    ${index > 0 ? '<span class="sep">/</span>' : ''}
    <button class="small ghost crumb-btn" data-index="${index}">${escapeHtml(item.name)}</button>
  `).join('');

  $all('.crumb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      state.explorer.stack = state.explorer.stack.slice(0, index + 1);
      loadExplorer();
    });
  });
}

async function loadExplorer() {
  renderBreadcrumbs();
  const accountId = state.explorer.accountId;
  const tbody = $('#explorer-table tbody');

  if (!accountId) {
    tbody.innerHTML = '';
    $('#explorer-empty').style.display = '';
    $('#explorer-empty').textContent = 'Vincula o selecciona una cuenta activa primero.';
    return;
  }

  try {
    const page = await api(`/drive/${accountId}/files?parentId=${encodeURIComponent(currentFolder().id)}&pageSize=200`);
    renderExplorerRows(accountId, page.files);

    const quota = await api(`/drive/${accountId}/quota`);
    $('#explorer-quota').textContent = quota.limit
      ? `Cuota: ${formatBytes(quota.usage)} de ${formatBytes(quota.limit)} (${quota.usedPercent ?? '?'} %)`
      : `Cuota: ${formatBytes(quota.usage)} usados (almacenamiento ilimitado)`;
  } catch (error) {
    tbody.innerHTML = '';
    $('#explorer-empty').style.display = '';
    $('#explorer-empty').textContent = error.message;
  }
}

function renderExplorerRows(accountId, files) {
  const tbody = $('#explorer-table tbody');
  $('#explorer-empty').style.display = files.length === 0 ? '' : 'none';

  tbody.innerHTML = files.map((file) => `
    <tr data-id="${file.id}" class="${file.isFolder ? 'folder-row' : ''}">
      <td>${file.isFolder ? '📁' : '📄'} ${escapeHtml(file.name)}${file.trashed ? ' <span class="badge danger">papelera</span>' : ''}</td>
      <td class="muted">${file.isFolder ? 'Carpeta' : escapeHtml(file.mimeType)}</td>
      <td class="muted">${file.isFolder ? '—' : formatBytes(file.size)}</td>
      <td class="muted">${formatDate(file.modifiedTime)}</td>
      <td class="actions-cell">
        ${file.isFolder ? '' : '<button class="small download-btn">Descargar</button>'}
        ${file.webViewLink ? '<button class="small link-btn">Abrir</button>' : ''}
        <button class="small rename-btn">Renombrar</button>
        <button class="small move-btn">Mover</button>
        ${!file.isFolder ? '<button class="small transfer-btn">Transferir</button>' : ''}
        ${file.trashed
          ? '<button class="small restore-btn">Restaurar</button>'
          : '<button class="small trash-btn">Papelera</button>'}
        <button class="small danger delete-btn">Eliminar</button>
      </td>
    </tr>
  `).join('');

  files.forEach((file) => {
    const row = $(`tr[data-id="${file.id}"]`, tbody);

    if (file.isFolder) {
      row.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        state.explorer.stack.push({ id: file.id, name: file.name });
        loadExplorer();
      });
    }

    const on = (selector, handler) => {
      const el = $(selector, row);
      if (el) el.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
    };

    on('.download-btn', () => downloadFile(accountId, file.id, file.name));
    on('.link-btn', () => window.open(file.webViewLink, '_blank', 'noopener'));
    on('.rename-btn', () => renameFile(accountId, file));
    on('.move-btn', () => moveFile(accountId, file));
    on('.transfer-btn', () => openTransferDialog(accountId, file));
    on('.trash-btn', () => setTrashed(accountId, file.id, true));
    on('.restore-btn', () => setTrashed(accountId, file.id, false));
    on('.delete-btn', () => deleteFile(accountId, file));
  });
}

async function downloadFile(accountId, fileId, filename) {
  try {
    const response = await api(`/drive/${accountId}/files/${fileId}/download`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renameFile(accountId, file) {
  const name = window.prompt('Nuevo nombre:', file.name);
  if (name === null || name === file.name) return;
  try {
    await api(`/drive/${accountId}/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await loadExplorer();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function moveFile(accountId, file) {
  const parentId = window.prompt(
    'Id de la carpeta destino (dentro de la misma cuenta). Déjalo en "root" para la raíz:',
    currentFolder().id,
  );
  if (parentId === null) return;
  try {
    await api(`/drive/${accountId}/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId }),
    });
    toast(`"${file.name}" movida`);
    await loadExplorer();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function setTrashed(accountId, fileId, trashed) {
  try {
    await api(`/drive/${accountId}/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed }),
    });
    await loadExplorer();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteFile(accountId, file) {
  if (!window.confirm(`Eliminar permanentemente "${file.name}"? Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/drive/${accountId}/files/${file.id}?permanent=true`, { method: 'DELETE' });
    toast(`"${file.name}" eliminada`);
    await loadExplorer();
  } catch (error) {
    toast(error.message, 'error');
  }
}

$('#explorer-refresh').addEventListener('click', loadExplorer);

$('#explorer-new-folder').addEventListener('click', async () => {
  if (!state.explorer.accountId) return toast('Selecciona una cuenta primero', 'error');
  const name = window.prompt('Nombre de la nueva carpeta:');
  if (!name) return;
  try {
    await api(`/drive/${state.explorer.accountId}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, parentId: currentFolder().id }),
    });
    toast(`Carpeta "${name}" creada`);
    await loadExplorer();
  } catch (error) {
    toast(error.message, 'error');
  }
});

$('#explorer-upload-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !state.explorer.accountId) return;

  try {
    const query = new URLSearchParams({ parentId: currentFolder().id, name: file.name });
    const form = new FormData();
    form.append('file', file);

    toast(`Subiendo "${file.name}"…`);
    await api(`/drive/${state.explorer.accountId}/files?${query}`, { method: 'POST', body: form });
    toast(`"${file.name}" subido`);
    await loadExplorer();
  } catch (error) {
    toast(error.message, 'error');
  }
});

// ─────────────────────────── vista multi-cuenta ──────────────────────────────

$('#aggregate-quota-refresh').addEventListener('click', async () => {
  try {
    const result = await api('/drive/quota');
    const tbody = $('#aggregate-quota-table tbody');
    tbody.innerHTML = result.results.map((q) => `
      <tr>
        <td>${escapeHtml(q.account.alias || q.account.email)}</td>
        <td>${formatBytes(q.usage)}</td>
        <td>${q.limit === null ? 'Ilimitado' : formatBytes(q.limit)}</td>
        <td>${q.usedPercent ?? '—'}${q.usedPercent !== null ? ' %' : ''}</td>
      </tr>
    `).join('') + result.failures.map((f) => `
      <tr><td>${escapeHtml(f.account.email)}</td><td colspan="3" class="muted">⚠ ${escapeHtml(f.message)}</td></tr>
    `).join('');

    $('#aggregate-quota-totals').textContent = result.totals.limit
      ? `Total: ${formatBytes(result.totals.usage)} de ${formatBytes(result.totals.limit)} · ` +
        `libres ${formatBytes(result.totals.freeBytes)} · destino recomendado: ` +
        `${state.accounts.find((a) => a.id === result.recommendedAccountId)?.email ?? '—'}`
      : `Total usado: ${formatBytes(result.totals.usage)}`;
  } catch (error) {
    toast(error.message, 'error');
  }
});

$('#aggregate-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = $('#aggregate-search-q').value.trim();
  if (!q) return;

  try {
    const result = await api(`/drive/search?q=${encodeURIComponent(q)}`);
    const container = $('#aggregate-search-results');

    const perAccount = result.results.map((page) => `
      <div style="margin-bottom:10px;">
        <strong>${escapeHtml(page.account.alias || page.account.email)}</strong>
        ${page.files.length === 0
          ? '<p class="muted">Sin resultados.</p>'
          : `<ul>${page.files.map((f) => `<li>${f.isFolder ? '📁' : '📄'} ${escapeHtml(f.name)} <span class="muted">(${formatBytes(f.size)})</span></li>`).join('')}</ul>`}
      </div>
    `).join('');

    const failures = result.failures.map((f) => `<p class="muted">⚠ ${escapeHtml(f.account.email)}: ${escapeHtml(f.message)}</p>`).join('');

    container.innerHTML = perAccount + failures || '<p class="empty">Sin resultados.</p>';
  } catch (error) {
    toast(error.message, 'error');
  }
});

// ─────────────────────────── redistribución ──────────────────────────────────

$('#rebalance-plan-btn').addEventListener('click', async () => {
  const threshold = $('#rebalance-threshold').value.trim();
  const query = threshold ? `?threshold=${encodeURIComponent(threshold)}` : '';

  try {
    const plan = await api(`/drive/rebalance/plan${query}`);
    $('#rebalance-notes').innerHTML = plan.notes.map((n) => `<p>${escapeHtml(n)}</p>`).join('');

    const tbody = $('#rebalance-moves-table tbody');
    $('#rebalance-empty').style.display = plan.moves.length === 0 ? '' : 'none';

    tbody.innerHTML = plan.moves.map((move, index) => `
      <tr data-index="${index}">
        <td>${escapeHtml(move.file.name)}</td>
        <td class="muted">${formatBytes(move.bytes)}</td>
        <td>${escapeHtml(move.from.alias || move.from.email)}</td>
        <td>${escapeHtml(move.to.alias || move.to.email)}</td>
        <td><button class="small primary execute-move-btn">Ejecutar</button></td>
      </tr>
    `).join('');

    $all('.execute-move-btn', tbody).forEach((btn) => {
      const index = Number(btn.closest('tr').dataset.index);
      btn.addEventListener('click', async () => {
        const move = plan.moves[index];
        btn.disabled = true;
        btn.textContent = 'Encolando…';
        try {
          await api('/drive/transfers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              from: { accountId: move.from.id, fileId: move.file.id },
              to: { accountId: move.to.id },
              deleteSource: true,
            }),
          });
          toast(`Transferencia de "${move.file.name}" encolada`);
          btn.textContent = 'Encolada ✓';
          showView('transfers');
        } catch (error) {
          toast(error.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Ejecutar';
        }
      });
    });
  } catch (error) {
    toast(error.message, 'error');
  }
});

// ─────────────────────────── diálogo de transferencia manual ─────────────────

let transferDialogFile = null;
let transferDialogAccountId = null;

function openTransferDialog(accountId, file) {
  transferDialogFile = file;
  transferDialogAccountId = accountId;
  $('#transfer-dialog-file').textContent = `${file.name} (${formatBytes(file.size)})`;
  $('#transfer-dialog-parent').value = '';
  $('#transfer-dialog-delete').checked = false;
  populateAccountSelects();
  // La propia cuenta de origen no tiene sentido como destino del formulario
  // manual (para copiar dentro de la misma cuenta ya está "Mover").
  $all('#transfer-dialog-account option').forEach((opt) => {
    opt.disabled = opt.value === accountId;
  });
  $('#transfer-dialog').showModal();
}

$('#transfer-dialog-cancel').addEventListener('click', () => $('#transfer-dialog').close());

$('#transfer-dialog-confirm').addEventListener('click', async () => {
  const toAccountId = $('#transfer-dialog-account').value;
  if (!toAccountId) return toast('No hay otra cuenta activa a la que transferir', 'error');

  try {
    await api('/drive/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: { accountId: transferDialogAccountId, fileId: transferDialogFile.id },
        to: { accountId: toAccountId, parentId: $('#transfer-dialog-parent').value.trim() || undefined },
        deleteSource: $('#transfer-dialog-delete').checked,
      }),
    });
    $('#transfer-dialog').close();
    toast(`Transferencia de "${transferDialogFile.name}" encolada`);
    showView('transfers');
  } catch (error) {
    toast(error.message, 'error');
  }
});

// ─────────────────────────── transferencias (cola) ───────────────────────────

async function loadTransfers() {
  try {
    const jobs = await api('/drive/transfers?limit=25');
    const tbody = $('#transfers-table tbody');
    $('#transfers-empty').style.display = jobs.length === 0 ? '' : 'none';

    tbody.innerHTML = jobs.map((job) => `
      <tr>
        <td class="mono">${escapeHtml(job.jobId)}</td>
        <td>${stateBadge(job.state)}</td>
        <td>
          <div class="progress-bar"><div style="width:${job.progress}%"></div></div>
        </td>
        <td class="muted">
          ${job.result ? `${job.result.verification} · ${job.result.sourceTrashed ? 'original a papelera' : 'copia'}` : ''}
          ${job.error ? `<span style="color:var(--danger);">${escapeHtml(job.error)}</span>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function stateBadge(stateName) {
  const map = { completed: 'ok', failed: 'danger', active: 'warn' };
  const cls = map[stateName] || '';
  return `<span class="badge ${cls || 'warn'}">${escapeHtml(stateName)}</span>`;
}

$('#transfers-refresh').addEventListener('click', loadTransfers);

function startTransfersPoll() {
  loadTransfers();
  stopTransfersPoll();
  state.transfersPoll = setInterval(loadTransfers, 4000);
}
function stopTransfersPoll() {
  if (state.transfersPoll) {
    clearInterval(state.transfersPoll);
    state.transfersPoll = null;
  }
}

// ─────────────────────────── arranque ────────────────────────────────────────

(async function init() {
  handleOAuthRedirect();
  await restoreSession();
})();
