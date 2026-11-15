// admin.js — presenter panel: PIN, questions, live session (count only,
// timer, close), proxy links with named ballots, exports, new AG + archives.
//
// No framework, no build step — plain DOM. Everything the page remembers
// lives in `state` below.

const { api: baseApi, escapeHtml, choicesOf, withEndsAt, paintCountdown, onTick, resultsBlock, toast, copy, setStatus, t, choiceLabel, locale, onLang, mountLangSwitch } = window.AG;

const state = {
  pin: readPin(),
  questions: [],
  voteCounts: {}, // questionId -> vote rows received (no breakdown while open)
  finalResults: {}, // questionId -> { tally, total } (closed only)
  editingQuestionId: null,
  voters: [],
  archives: [],
  socket: null,
  online: null,
};

const $ = (id) => document.getElementById(id);

function readPin() {
  try { return localStorage.getItem('agVotingAdminPin'); } catch { return null; }
}
function savePin(pin) {
  try { pin ? localStorage.setItem('agVotingAdminPin', pin) : localStorage.removeItem('agVotingAdminPin'); } catch { /* private mode */ }
}

// Admin calls carry the PIN; a 401 means it's wrong/stale -> back to the PIN screen.
async function api(path, opts = {}) {
  try {
    return await baseApi(path, { ...opts, pin: opts.auth ? state.pin : undefined });
  } catch (err) {
    if (err.status === 401 && opts.auth) logout(t('a.pinRefused'));
    throw err;
  }
}

// ---------- PIN ----------

async function tryPin(pin) {
  $('pin-error').classList.add('hidden');
  $('pin-submit').disabled = true;
  try {
    await baseApi('/api/admin/verify', { method: 'POST', body: { pin } });
    state.pin = pin;
    savePin(pin);
    enterDashboard();
  } catch {
    $('pin-error').textContent = t('a.pinWrong');
    $('pin-error').classList.remove('hidden');
  } finally {
    $('pin-submit').disabled = false;
  }
}

$('pin-submit').addEventListener('click', () => {
  const pin = $('pin-input').value.trim();
  if (pin) tryPin(pin);
});
$('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('pin-submit').click();
});

function logout(message) {
  state.pin = null;
  savePin(null);
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  $('dashboard').classList.add('hidden');
  $('pin-screen').classList.remove('hidden');
  $('pin-input').value = '';
  if (message) {
    $('pin-error').textContent = message;
    $('pin-error').classList.remove('hidden');
  }
}
$('logout-btn').addEventListener('click', () => logout());

async function enterDashboard() {
  $('pin-screen').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  selectTab((location.hash || '#seance').slice(1));
  renderJoinQr();
  connectSocket();
  try {
    await Promise.all([refreshQuestions(), refreshVoters(), refreshArchives()]);
  } catch (err) {
    console.error(err);
  }
}

// ---------- tabs ----------

const TABS = ['seance', 'preparer', 'procurations', 'cloture'];
function selectTab(name) {
  if (!TABS.includes(name)) name = 'seance';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  TABS.forEach((t) => $(`tab-${t}`).classList.toggle('hidden', t !== name));
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

// ---------- join QR ----------

function renderJoinQr() {
  const url = `${location.origin}/`;
  $('join-url').textContent = url;
  window.QRCode.toCanvas($('join-qr'), url, { width: 200, margin: 0 }, () => {});
}
$('copy-join-link-btn').addEventListener('click', () => copy(`${location.origin}/`, t('a.linkCopied')));

// ---------- question form ----------

function addOptionRow(value = '') {
  const row = document.createElement('div');
  row.className = 'input-row';
  row.innerHTML = `<input type="text" data-i18n-ph="a.optionPlaceholder" placeholder="${escapeHtml(t('a.optionPlaceholder'))}" /><button type="button" class="icon-btn" aria-label="${escapeHtml(t('a.remove'))}">✕</button>`;
  row.querySelector('input').value = value;
  row.querySelector('button').addEventListener('click', () => {
    if ($('options-list').children.length > 2) row.remove();
  });
  $('options-list').appendChild(row);
}
function getOptionValues() {
  return Array.from($('options-list').querySelectorAll('input')).map((i) => i.value.trim()).filter(Boolean);
}
function resetOptionsList(values = ['', '']) {
  $('options-list').innerHTML = '';
  values.forEach((v) => addOptionRow(v));
}

$('question-type').addEventListener('change', () => {
  const isCustom = $('question-type').value === 'custom';
  $('options-field').classList.toggle('hidden', !isCustom);
  if (isCustom && $('options-list').children.length === 0) resetOptionsList();
});
$('add-option-btn').addEventListener('click', () => addOptionRow());

function renderFormLabels() {
  const editing = !!state.editingQuestionId;
  $('form-title').textContent = t(editing ? 'a.formEdit' : 'a.formNew');
  $('save-question-btn').textContent = t(editing ? 'a.save' : 'a.addQuestion');
}

function resetForm() {
  state.editingQuestionId = null;
  renderFormLabels();
  $('cancel-edit-btn').classList.add('hidden');
  $('question-text').value = '';
  $('question-type').value = 'standard';
  $('options-field').classList.add('hidden');
  resetOptionsList();
  $('form-error').classList.add('hidden');
}
$('cancel-edit-btn').addEventListener('click', resetForm);

function startEdit(q) {
  selectTab('preparer');
  state.editingQuestionId = q.id;
  renderFormLabels();
  $('cancel-edit-btn').classList.remove('hidden');
  $('question-text').value = q.text;
  $('question-type').value = q.type;
  $('options-field').classList.toggle('hidden', q.type !== 'custom');
  resetOptionsList(q.type === 'custom' && q.options && q.options.length ? q.options : ['', '']);
  $('form-error').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('question-text').focus();
}

function showFormError(msg) {
  $('form-error').textContent = msg;
  $('form-error').classList.remove('hidden');
}

$('save-question-btn').addEventListener('click', async () => {
  const text = $('question-text').value.trim();
  const type = $('question-type').value;
  const options = type === 'custom' ? getOptionValues() : undefined;
  $('form-error').classList.add('hidden');
  if (!text) return showFormError(t('a.errQuestionText'));
  if (type === 'custom' && (!options || options.length < 2)) return showFormError(t('a.errOptions'));

  $('save-question-btn').disabled = true;
  try {
    const body = { text, type, options };
    if (state.editingQuestionId) {
      await api(`/api/questions/${state.editingQuestionId}`, { method: 'PATCH', body, auth: true });
      toast(t('a.questionSaved'));
    } else {
      await api('/api/questions', { method: 'POST', body, auth: true });
      toast(t('a.questionAdded'));
    }
    resetForm();
    await refreshQuestions();
    $('question-text').focus();
  } catch (err) {
    showFormError(err.message);
  } finally {
    $('save-question-btn').disabled = false;
  }
});
$('question-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('question-type').value === 'standard') $('save-question-btn').click();
});

// ---------- questions: fetch + render ----------

async function refreshQuestions() {
  const questions = await api('/api/questions');
  state.questions = questions.map(withEndsAt);

  const open = state.questions.find((q) => q.status === 'open');
  if (open) {
    const res = await api(`/api/questions/${open.id}/vote-count`);
    state.voteCounts[open.id] = res.voteCount;
  }
  // Closed questions: fetch the final result once (cached afterwards).
  await Promise.all(
    state.questions
      .filter((q) => q.status === 'closed' && !state.finalResults[q.id])
      .map(async (q) => {
        const res = await api(`/api/questions/${q.id}/results`);
        state.finalResults[q.id] = { tally: res.tally, total: res.total };
      })
  );
  renderAll();
}

function renderAll() {
  renderLive();
  renderQuestionsList();
  renderClosure();
  const open = state.questions.some((q) => q.status === 'open');
  const drafts = state.questions.filter((q) => q.status === 'draft').length;
  $('pill-live').classList.toggle('hidden', !open);
  $('pill-drafts').classList.toggle('hidden', drafts === 0);
  $('pill-drafts').textContent = drafts;
}

function renderLive() {
  const open = state.questions.find((q) => q.status === 'open');
  $('live-card').classList.toggle('hidden', !open);
  $('idle-card').classList.toggle('hidden', !!open);

  if (!open) {
    const next = state.questions.find((q) => q.status === 'draft');
    $('next-question-box').classList.toggle('hidden', !next);
    $('no-draft-text').classList.toggle('hidden', !!next || state.questions.length === 0);
    $('no-question-text').classList.toggle('hidden', state.questions.length > 0);
    if (next) {
      $('next-question-text').textContent = next.text;
      $('open-next-btn').onclick = () => openQuestion(next.id);
    }
    return;
  }

  $('live-question-text').textContent = open.text;
  const count = state.voteCounts[open.id] || 0;
  $('live-vote-count').textContent = count;
  $('live-vote-count-label').textContent = t(count === 1 ? 'a.votesReceived1' : 'a.votesReceived');
  $('timer-cancel-btn').classList.toggle('hidden', open.timerEndsAt == null);
  paintCountdown($('live-countdown'), open);
  $('close-question-btn').onclick = () => closeQuestion(open.id);
}

onTick(() => {
  const open = state.questions.find((q) => q.status === 'open');
  if (open) paintCountdown($('live-countdown'), open, { doneText: t(open.timerAutoClose ? 'a.timerClosing' : 'a.timeUp') });
});

const STATUS_KEY = { draft: 'a.statusDraft', open: 'a.statusOpen', closed: 'a.statusClosed' };

function renderQuestionsList() {
  const list = $('questions-list');
  list.innerHTML = '';
  if (!state.questions.length) {
    list.innerHTML = `<p class="muted">${escapeHtml(t('a.emptyAgenda'))} <a href="#preparer" data-goto="preparer">${escapeHtml(t('a.goPrepare'))}</a></p>`;
    list.querySelector('[data-goto]').addEventListener('click', (e) => {
      e.preventDefault();
      selectTab('preparer');
    });
    return;
  }

  state.questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.className = 'card q-item' + (q.status === 'open' ? ' is-open' : '');
    card.innerHTML =
      `<div class="q-num">${String(i + 1).padStart(2, '0')}</div>` +
      `<div class="q-body"><span class="badge badge-${q.status}">${escapeHtml(t(STATUS_KEY[q.status] || q.status))}</span>` +
      `<div class="q-title">${escapeHtml(q.text)}</div>` +
      `<p class="q-meta">${q.type === 'standard' ? escapeHtml(t('a.typeStandard')) : escapeHtml((q.options || []).join(' · '))}</p></div>`;
    const body = card.querySelector('.q-body');

    if (q.status === 'closed' && state.finalResults[q.id]) {
      const r = state.finalResults[q.id];
      body.appendChild(resultsBlock(q, r.tally, r.total, { donut: true }));
    }

    const actions = document.createElement('div');
    actions.className = 'btn-row q-actions';
    if (q.status === 'draft') {
      actions.appendChild(makeButton(t('a.openVote'), 'btn btn-primary btn-sm', () => openQuestion(q.id)));
      actions.appendChild(makeButton(t('a.edit'), 'btn btn-sm', () => startEdit(q)));
      actions.appendChild(makeButton(t('a.delete'), 'btn btn-danger btn-sm', () => deleteQuestion(q)));
    } else if (q.status === 'open') {
      actions.appendChild(makeButton(t('a.closeVote'), 'btn btn-primary btn-sm', () => closeQuestion(q.id)));
    } else {
      actions.appendChild(makeButton(t('a.delete'), 'btn btn-danger btn-sm', () => deleteQuestion(q)));
    }
    body.appendChild(actions);
    list.appendChild(card);
  });
}

function makeButton(text, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.className = className;
  btn.addEventListener('click', onClick);
  return btn;
}

// ---------- question actions ----------

async function openQuestion(id) {
  const other = state.questions.find((q) => q.status === 'open' && q.id !== id);
  if (other && !confirm(t('a.confirmOpenOther', { q: other.text }))) return;
  try {
    await api(`/api/questions/${id}/open`, { method: 'POST', auth: true });
    selectTab('seance');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    alert(err.message);
  }
}

async function closeQuestion(id) {
  const btn = $('close-question-btn');
  btn.disabled = true;
  try {
    await api(`/api/questions/${id}/close`, { method: 'POST', auth: true });
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteQuestion(q) {
  const message = t(q.status === 'closed' ? 'a.confirmDeleteClosed' : 'a.confirmDelete', { q: q.text });
  if (!confirm(message)) return;
  try {
    await api(`/api/questions/${q.id}`, { method: 'DELETE', auth: true });
    delete state.finalResults[q.id];
    await refreshQuestions();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- timer ----------

const autoCloseBox = $('timer-autoclose');
try { autoCloseBox.checked = localStorage.getItem('agTimerAutoClose') !== '0'; } catch { autoCloseBox.checked = true; }
autoCloseBox.addEventListener('change', () => {
  try { localStorage.setItem('agTimerAutoClose', autoCloseBox.checked ? '1' : '0'); } catch { /* ignore */ }
});

async function startTimer(seconds) {
  const open = state.questions.find((q) => q.status === 'open');
  if (!open) return;
  $('timer-error').classList.add('hidden');
  try {
    await api(`/api/questions/${open.id}/timer`, { method: 'POST', body: { seconds, autoClose: autoCloseBox.checked }, auth: true });
  } catch (err) {
    $('timer-error').textContent = err.message;
    $('timer-error').classList.remove('hidden');
  }
}
$('timer-presets').querySelectorAll('[data-seconds]').forEach((b) =>
  b.addEventListener('click', () => startTimer(parseInt(b.dataset.seconds, 10)))
);
$('timer-custom-btn').addEventListener('click', () => {
  const s = parseInt($('timer-custom').value, 10);
  if (!Number.isInteger(s) || s < 5 || s > 3600) {
    $('timer-error').textContent = t('a.timerRange');
    $('timer-error').classList.remove('hidden');
    return;
  }
  startTimer(s);
});
$('timer-cancel-btn').addEventListener('click', async () => {
  const open = state.questions.find((q) => q.status === 'open');
  if (!open) return;
  try {
    await api(`/api/questions/${open.id}/timer`, { method: 'DELETE', auth: true });
  } catch (err) {
    alert(err.message);
  }
});

// ---------- CSV import ----------

// Minimal RFC4180 parser: quoted fields, escaped quotes, commas/newlines
// inside quotes, \r\n or \n line endings.
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* the following \n ends the line */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadBlob(content, filename, type) {
  const blob = new Blob(content, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$('download-template-btn').addEventListener('click', () => {
  const rows = [
    ['Question', 'Type', 'Options'],
    ['Approuver le budget 2026 ?', 'Standard', ''],
    ['Date de la prochaine sortie', 'Personnalisé', '3 mars 2027;10 mars 2027;17 mars 2027'],
  ];
  // BOM so Excel reads the accents correctly.
  downloadBlob(['﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')], 'modele-questions-ag.csv', 'text/csv;charset=utf-8;');
});

function showImportStatus(message, isError) {
  const s = $('import-status');
  s.textContent = message;
  s.classList.remove('hidden');
  s.classList.toggle('error-text', isError);
  s.classList.toggle('muted', !isError);
}

$('import-csv-btn').addEventListener('click', async () => {
  const input = $('import-csv-input');
  const file = input.files[0];
  if (!file) return showImportStatus(t('a.importChoose'), true);
  const btn = $('import-csv-btn');
  btn.disabled = true;
  btn.textContent = t('a.importing');
  $('import-status').classList.add('hidden');
  try {
    let text = await file.text();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const allRows = parseCsvText(text).filter((r) => r.some((cell) => cell.trim() !== ''));
    if (!allRows.length) throw new Error(t('a.importEmpty'));
    const dataRows = allRows.slice(1);
    if (!dataRows.length) throw new Error(t('a.importNoRows'));
    if (!confirm(t('a.importConfirm', { n: dataRows.length }))) return;

    let success = 0;
    const errors = [];
    // Sequential so the order on the board matches the file.
    for (let i = 0; i < dataRows.length; i++) {
      const line = i + 2;
      const [rawText, rawType, rawOptions] = dataRows[i];
      const questionText = (rawText || '').trim();
      if (!questionText) { errors.push(t('a.importMissing', { l: line })); continue; }
      const typeRaw = (rawType || '').trim().toLowerCase();
      const isCustom = typeRaw.startsWith('custom') || typeRaw.startsWith('personnalis') || typeRaw.startsWith('perso');
      let options;
      if (isCustom) {
        options = (rawOptions || '').split(';').map((o) => o.trim()).filter(Boolean);
        if (options.length < 2) { errors.push(t('a.importOptions', { l: line })); continue; }
      }
      try {
        await api('/api/questions', { method: 'POST', body: { text: questionText, type: isCustom ? 'custom' : 'standard', options }, auth: true });
        success++;
      } catch (err) {
        errors.push(t('a.importLineErr', { l: line, e: err.message }));
      }
    }
    let summary = t('a.importDone', { n: success });
    if (errors.length) summary += `\n${t('a.importSkipped', { n: errors.length })}\n` + errors.join('\n');
    showImportStatus(summary, errors.length > 0);
    await refreshQuestions();
  } catch (err) {
    showImportStatus(t('a.importFailed', { e: err.message }), true);
  } finally {
    btn.disabled = false;
    btn.textContent = t('a.import');
    input.value = '';
  }
});

// ---------- procurations ----------

const voterLink = (token) => `${location.origin}/?token=${token}`;

// Ready-to-paste message for the proxy holder — always in both languages,
// since it goes to people whatever language the admin panel is in.
function proxyMessage(v) {
  const names = (v.proxyNames || []).join(', ');
  return (
    `Salut ${v.displayName} ! Voici ton lien de vote personnel pour l'AG de l'EPFL Rocket Team. ` +
    `Il compte pour ${v.weight} voix : la tienne + ${names}. Tu pourras voter différemment pour chaque personne. ` +
    `Ne le partage avec personne.\n\n` +
    `Hi ${v.displayName}! Here is your personal voting link for the EPFL Rocket Team AG. ` +
    `It holds ${v.weight} votes: your own + ${names}. You can vote differently for each person. ` +
    `Please don't share it.\n\n` +
    voterLink(v.token)
  );
}

function addProxyNameRow(value = '') {
  const row = document.createElement('div');
  row.className = 'input-row';
  row.innerHTML = `<input type="text" data-i18n-ph="a.proxyRepresentedPlaceholder" placeholder="${escapeHtml(t('a.proxyRepresentedPlaceholder'))}" /><button type="button" class="icon-btn" aria-label="${escapeHtml(t('a.remove'))}">✕</button>`;
  const input = row.querySelector('input');
  input.value = value;
  input.addEventListener('input', updateCreateVoterLabel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addProxyNameRow();
      $('proxy-names').lastElementChild.querySelector('input').focus();
    }
  });
  row.querySelector('button').addEventListener('click', () => {
    if ($('proxy-names').children.length > 1) row.remove();
    else input.value = '';
    updateCreateVoterLabel();
  });
  $('proxy-names').appendChild(row);
  updateCreateVoterLabel();
}
function getProxyNames() {
  return Array.from($('proxy-names').querySelectorAll('input')).map((i) => i.value.trim()).filter(Boolean);
}
function updateCreateVoterLabel() {
  const n = getProxyNames().length;
  $('create-voter-btn').textContent = n ? t('a.proxyCreateN', { n: n + 1 }) : t('a.proxyCreate');
}
function resetProxyForm() {
  $('voter-name').value = '';
  $('proxy-names').innerHTML = '';
  addProxyNameRow();
}
$('add-proxy-name-btn').addEventListener('click', () => {
  addProxyNameRow();
  $('proxy-names').lastElementChild.querySelector('input').focus();
});

async function refreshVoters() {
  state.voters = await api('/api/voters', { auth: true });
  renderVoters();
}

function renderVoters() {
  const list = $('voters-list');
  list.innerHTML = '';
  const n = state.voters.length;
  $('pill-voters').classList.toggle('hidden', n === 0);
  $('pill-voters').textContent = n;
  const totalVotes = state.voters.reduce((s, v) => s + v.weight, 0);
  $('voters-summary').textContent = n ? t('a.proxySummary', { n, v: totalVotes }) : '';

  if (!n) {
    list.innerHTML = `<p class="muted" style="margin: 0;">${escapeHtml(t('a.proxyNone'))}</p>`;
    return;
  }
  for (const v of state.voters) {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML =
      `<div class="info"><b>${escapeHtml(v.displayName)}<span class="votes-pill">${escapeHtml(t('a.proxyVotes', { n: v.weight }))}</span></b>` +
      `<span>${escapeHtml(t('a.proxyRepresents', { names: (v.proxyNames || []).join(', ') || '—' }))}</span></div>`;
    const actions = document.createElement('div');
    actions.className = 'btn-row';
    actions.appendChild(makeButton(t('a.copyMessage'), 'btn btn-primary btn-sm', () => copy(proxyMessage(v), t('a.messageCopied'))));
    actions.appendChild(makeButton(t('a.copy'), 'btn btn-sm', () => copy(voterLink(v.token), t('a.linkCopied'))));
    actions.appendChild(makeButton(t('a.qr'), 'btn btn-sm', () => showLinkDialog(v)));
    actions.appendChild(
      makeButton(t('a.revoke'), 'btn btn-danger btn-sm', async () => {
        if (!confirm(t('a.confirmRevoke', { name: v.displayName }))) return;
        try {
          await api(`/api/voters/${v.token}`, { method: 'DELETE', auth: true });
          await refreshVoters();
        } catch (err) {
          alert(err.message);
        }
      })
    );
    row.appendChild(actions);
    list.appendChild(row);
  }
}

$('create-voter-btn').addEventListener('click', async () => {
  const displayName = $('voter-name').value.trim();
  const proxyNames = getProxyNames();
  const errEl = $('voter-form-error');
  errEl.classList.add('hidden');
  const fail = (m) => { errEl.textContent = m; errEl.classList.remove('hidden'); };
  if (!displayName) return fail(t('a.errHolder'));
  if (!proxyNames.length) return fail(t('a.errRepresented'));

  $('create-voter-btn').disabled = true;
  try {
    const v = await api('/api/voters', { method: 'POST', body: { displayName, proxyNames }, auth: true });
    resetProxyForm();
    await refreshVoters();
    showLinkDialog(v);
  } catch (err) {
    fail(err.message);
  } finally {
    $('create-voter-btn').disabled = false;
  }
});

function showLinkDialog(v) {
  const url = voterLink(v.token);
  $('link-dialog-name').textContent = v.displayName;
  $('link-dialog-sub').textContent = t('a.dialogSub', { n: v.weight, names: (v.proxyNames || []).join(', ') });
  $('link-dialog-url').textContent = url;
  window.QRCode.toCanvas($('link-dialog-qr'), url, { width: 220, margin: 0 }, () => {});
  $('link-dialog-copy').onclick = () => copy(url, t('a.linkCopied'));
  $('link-dialog-message').onclick = () => copy(proxyMessage(v), t('a.messageCopied'));
  $('link-dialog').showModal();
}
$('link-dialog-close').addEventListener('click', () => $('link-dialog').close());

// ---------- closure: exports, new AG, archives ----------

function defaultArchiveTitle() {
  return t('a.defaultArchiveTitle', { d: new Date().toLocaleDateString('fr-CH') });
}

function renderClosure() {
  const anyOpen = state.questions.some((q) => q.status === 'open');
  const has = state.questions.length > 0;
  $('export-pdf-btn').disabled = !has || anyOpen;
  $('export-csv-btn').disabled = !has || anyOpen;
  $('end-voting-hint').textContent = anyOpen
    ? t('a.endOpen')
    : !has
    ? t('a.endEmpty')
    : t('a.endReady', { c: state.questions.filter((q) => q.status === 'closed').length, n: state.questions.length });

  $('new-session-btn').disabled = anyOpen;
  $('new-session-hint').textContent = anyOpen ? t('a.newAgClosing') : has ? t('a.newAgExportFirst') : '';
  $('archive-title').placeholder = defaultArchiveTitle();
}

const STATUS_EXPORT = { draft: 'x.statusDraft', open: 'x.statusOpen', closed: 'x.statusClosed' };

function exportPdf(questions, title, filename) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 48;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const usable = pageWidth - marginX * 2;
  let y = 64;
  const ensure = (h) => {
    if (y + h > pageHeight - 56) {
      doc.addPage();
      y = 56;
    }
  };

  doc.setFillColor('#da291c');
  doc.rect(0, 0, pageWidth, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor('#111111');
  doc.text(t('x.title'), marginX, y);
  y += 22;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor('#555555');
  doc.text(`EPFL Rocket Team — ${title}`, marginX, y);
  y += 14;
  doc.text(t('x.generated', { d: new Date().toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }) }), marginX, y);
  y += 12;
  doc.setDrawColor('#dddddd');
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 28;

  if (!questions.length) {
    doc.setTextColor('#000000');
    doc.text(t('x.none'), marginX, y);
  }

  questions.forEach((q, index) => {
    ensure(70);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor('#000000');
    const lines = doc.splitTextToSize(`${index + 1}. ${q.text}`, usable);
    doc.text(lines, marginX, y);
    y += lines.length * 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor('#888888');
    const typeLabel = q.type === 'standard' ? t('a.typeStandard') : (q.options || []).join(' / ');
    doc.text(`${typeLabel} — ${t(STATUS_EXPORT[q.status] || q.status)}`, marginX, y);
    y += 18;

    if (q.status === 'closed' && q.tally) {
      const choices = choicesOf(q);
      const max = Math.max(0, ...choices.map((c) => q.tally[c] || 0));
      const leaders = choices.filter((c) => (q.tally[c] || 0) === max);
      for (const c of choices) {
        ensure(18);
        const count = q.tally[c] || 0;
        const pct = q.total > 0 ? Math.round((count / q.total) * 100) : 0;
        const isWinner = max > 0 && leaders.length === 1 && leaders[0] === c;
        doc.setFontSize(11);
        doc.setFont('helvetica', isWinner ? 'bold' : 'normal');
        doc.setTextColor('#000000');
        doc.text(choiceLabel(c), marginX + 12, y);
        doc.text(t('x.votesPct', { c: count, p: pct }), marginX + 230, y, { align: 'right' });
        doc.setFillColor('#eeeeee');
        doc.rect(marginX + 245, y - 8, 200, 8, 'F');
        if (pct > 0) {
          doc.setFillColor(isWinner ? '#da291c' : '#888888');
          doc.rect(marginX + 245, y - 8, 2 * pct, 8, 'F');
        }
        y += 17;
      }
      ensure(18);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor('#333333');
      doc.text(t('x.total', { n: q.total }), marginX + 12, y);
      doc.setFont('helvetica', 'normal');
      y += 26;
    } else {
      ensure(18);
      doc.setFontSize(11);
      doc.setTextColor('#a05a00');
      doc.text(t('x.noResult'), marginX + 12, y);
      y += 26;
    }
  });

  doc.save(filename);
}

function exportCsv(questions, filename) {
  const rows = [t('x.csvHeader').split('|')];
  questions.forEach((q, i) => {
    const typeLabel = q.type === 'standard' ? t('x.typeStandard') : t('x.typeCustom', { o: (q.options || []).join(', ') });
    const label = `Q${i + 1}. ${q.text}`;
    const status = t(STATUS_EXPORT[q.status] || q.status);
    if (q.status === 'closed' && q.tally) {
      for (const c of choicesOf(q)) {
        const count = q.tally[c] || 0;
        const pct = q.total > 0 ? Math.round((count / q.total) * 100) : 0;
        rows.push([label, typeLabel, status, choiceLabel(c), count, `${pct}%`, q.total]);
      }
    } else {
      rows.push([label, typeLabel, status, '', '', '', '']);
    }
  });
  downloadBlob(['﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')], filename, 'text/csv;charset=utf-8;');
}

const fileName = (title, ext) => `${t('x.filePrefix')}-${slug(title)}.${ext}`;
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ag';

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

$('export-pdf-btn').addEventListener('click', (e) =>
  withBusy(e.currentTarget, t('a.generating'), async () => {
    const questions = await api('/api/export/results', { auth: true });
    const title = $('archive-title').value.trim() || defaultArchiveTitle();
    exportPdf(questions, title, fileName(title, 'pdf'));
  })
);
$('export-csv-btn').addEventListener('click', (e) =>
  withBusy(e.currentTarget, t('a.generating'), async () => {
    const questions = await api('/api/export/results', { auth: true });
    const title = $('archive-title').value.trim() || defaultArchiveTitle();
    exportCsv(questions, fileName(title, 'csv'));
  })
);

$('new-session-btn').addEventListener('click', async () => {
  const title = $('archive-title').value.trim() || defaultArchiveTitle();
  const deleteVoters = $('delete-voters').checked;
  const n = state.questions.length;
  const msg =
    (n ? t('a.newAgConfirmQ', { n, t: title }) : t('a.newAgConfirmEmpty')) +
    '\n\n' + (deleteVoters ? t('a.newAgConfirmDelVoters', { n: state.voters.length }) : t('a.newAgConfirmKeepVoters')) +
    '\n\n' + t('a.newAgConfirmEnd');
  if (!confirm(msg)) return;
  await withBusy($('new-session-btn'), t('a.archiving'), async () => {
    const res = await api('/api/session/new', { method: 'POST', body: { title, deleteVoters }, auth: true });
    state.finalResults = {};
    state.voteCounts = {};
    $('archive-title').value = '';
    $('delete-voters').checked = false;
    await Promise.all([refreshQuestions(), refreshVoters(), refreshArchives()]);
    toast(res.archiveId ? t('a.newAgDone', { n: res.archivedQuestions }) : t('a.newAgDoneEmpty'));
  });
});

async function refreshArchives() {
  state.archives = await api('/api/archives', { auth: true });
  renderArchives();
}

function renderArchives() {
  const list = $('archives-list');
  list.innerHTML = '';
  if (!state.archives.length) {
    list.innerHTML = `<p class="muted" style="margin: 0;">${escapeHtml(t('a.archivesNone'))}</p>`;
    return;
  }
  for (const a of state.archives) {
    const row = document.createElement('div');
    row.className = 'row-item';
    const date = new Date(a.createdAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
    row.innerHTML = `<div class="info"><b>${escapeHtml(a.title)}</b><span>${escapeHtml(t('a.archiveLine', { n: a.questionCount, d: date }))}</span></div>`;
    const actions = document.createElement('div');
    actions.className = 'btn-row';
    const load = () => api(`/api/archives/${a.id}`, { auth: true });
    actions.appendChild(makeButton('PDF', 'btn btn-sm', (e) => withBusy(e.currentTarget, '…', async () => { const d = await load(); exportPdf(d.questions, d.title, fileName(d.title, 'pdf')); })));
    actions.appendChild(makeButton('CSV', 'btn btn-sm', (e) => withBusy(e.currentTarget, '…', async () => { const d = await load(); exportCsv(d.questions, fileName(d.title, 'csv')); })));
    row.appendChild(actions);
    list.appendChild(row);
  }
}

// ---------- live updates ----------

function upsertQuestionLocal(question) {
  const idx = state.questions.findIndex((q) => q.id === question.id);
  if (idx >= 0) state.questions[idx] = { ...state.questions[idx], ...question };
  else state.questions.push(question);
}

function connectSocket() {
  if (state.socket) return;
  const socket = io();
  state.socket = socket;

  socket.on('connect', () => {
    state.online = true;
    renderStatus();
    refreshQuestions().catch(() => {});
  });
  socket.on('disconnect', () => {
    state.online = false;
    renderStatus();
  });

  socket.on('questions:changed', () => refreshQuestions().catch(() => {}));

  socket.on('question:open', (q) => {
    // Opening one question closes any other on the server.
    state.questions.forEach((x) => { if (x.status === 'open' && x.id !== q.id) x.status = 'closed'; });
    upsertQuestionLocal(withEndsAt(q));
    state.voteCounts[q.id] = 0;
    renderAll();
  });

  // While open, only this total is broadcast — never the breakdown.
  socket.on('vote-count:update', ({ questionId, voteCount }) => {
    state.voteCounts[questionId] = voteCount;
    renderLive();
  });

  socket.on('timer:update', ({ questionId, remainingMs, autoClose }) => {
    const q = state.questions.find((x) => x.id === questionId);
    if (!q) return;
    q.timerRemainingMs = remainingMs;
    q.timerAutoClose = autoClose;
    withEndsAt(q);
    renderLive();
  });

  socket.on('question:closed', ({ questionId, tally, total }) => {
    state.finalResults[questionId] = { tally, total };
    const q = state.questions.find((x) => x.id === questionId);
    if (q) {
      q.status = 'closed';
      q.timerEndsAt = null;
    }
    renderAll();
  });

  socket.on('session:reset', () => {
    state.finalResults = {};
    state.voteCounts = {};
    Promise.all([refreshQuestions(), refreshVoters(), refreshArchives()]).catch(() => {});
  });
}

function renderStatus() {
  const el = $('connection-status');
  if (state.online === null) setStatus(el, false, t('status.connecting'));
  else setStatus(el, state.online, t(state.online ? 'status.live' : 'status.reconnecting'));
}

// ---------- language ----------

onLang(() => {
  document.title = t('a.pageTitle');
  renderStatus();
  renderFormLabels();
  updateCreateVoterLabel();
  renderAll();
  renderVoters();
  renderArchives();
});

// ---------- start ----------

document.querySelectorAll('.js-lang-switch').forEach(mountLangSwitch);
document.title = t('a.pageTitle');
renderStatus();
renderFormLabels();
resetOptionsList();
resetProxyForm();
if (state.pin) enterDashboard();
else $('pin-screen').classList.remove('hidden');
