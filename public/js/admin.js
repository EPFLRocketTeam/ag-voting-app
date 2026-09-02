// admin.js — panneau présentateur : PIN, gestion des questions, compteur en
// direct (sans détail), résultats finaux, gestion des procurations.
//
// Pas de framework, pas d'étape de build — juste du DOM classique. L'état
// tient dans un seul objet `state` en haut du fichier pour que tout ce que
// la page retient soit visible d'un coup d'œil.

const STANDARD_LABELS = ['Oui', 'Non', 'Blanc'];

const state = {
  adminPin: localStorage.getItem('agVotingAdminPin') || null,
  questions: [],              // liste complète depuis GET /api/questions
  voteCounts: {},             // questionId -> nombre de votes reçus (pendant que c'est ouvert, sans détail)
  finalResults: {},           // questionId -> { tally, total } (uniquement une fois fermé)
  editingQuestionId: null,    // null = formulaire "Nouvelle question" ; sinon on modifie ce brouillon
  voters: [],                 // liste des procurations créées
};

// ---------- références DOM ----------

const el = {
  pinScreen: document.getElementById('pin-screen'),
  pinInput: document.getElementById('pin-input'),
  pinSubmit: document.getElementById('pin-submit'),
  pinError: document.getElementById('pin-error'),

  dashboard: document.getElementById('dashboard'),
  connectionStatus: document.getElementById('connection-status'),

  liveSection: document.getElementById('live-section'),
  liveQuestionText: document.getElementById('live-question-text'),
  liveVoteCount: document.getElementById('live-vote-count'),
  liveVoteCountLabel: document.getElementById('live-vote-count-label'),
  closeQuestionBtn: document.getElementById('close-question-btn'),

  formTitle: document.getElementById('form-title'),
  questionText: document.getElementById('question-text'),
  questionType: document.getElementById('question-type'),
  optionsField: document.getElementById('options-field'),
  optionsList: document.getElementById('options-list'),
  addOptionBtn: document.getElementById('add-option-btn'),
  saveQuestionBtn: document.getElementById('save-question-btn'),
  cancelEditBtn: document.getElementById('cancel-edit-btn'),
  formError: document.getElementById('form-error'),

  questionsEmpty: document.getElementById('questions-empty'),
  questionsList: document.getElementById('questions-list'),

  voterName: document.getElementById('voter-name'),
  voterWeight: document.getElementById('voter-weight'),
  createVoterBtn: document.getElementById('create-voter-btn'),
  voterFormError: document.getElementById('voter-form-error'),
  votersList: document.getElementById('voters-list'),
};

// ---------- petit utilitaire d'appel API ----------

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers['x-admin-token'] = state.adminPin;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error((data && data.error) || `Échec de la requête (${res.status})`);
  }
  return data;
}

// ---------- écran PIN ----------

async function tryPin(pin) {
  el.pinError.classList.add('hidden');
  el.pinSubmit.disabled = true;
  try {
    await api('/api/admin/verify', { method: 'POST', body: { pin } });
    state.adminPin = pin;
    localStorage.setItem('agVotingAdminPin', pin);
    enterDashboard();
  } catch (err) {
    el.pinError.textContent = 'PIN incorrect — réessaie.';
    el.pinError.classList.remove('hidden');
  } finally {
    el.pinSubmit.disabled = false;
  }
}

el.pinSubmit.addEventListener('click', () => {
  const pin = el.pinInput.value.trim();
  if (pin) tryPin(pin);
});
el.pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.pinSubmit.click();
});

function enterDashboard() {
  el.pinScreen.classList.add('hidden');
  el.dashboard.classList.remove('hidden');
  connectSocket();
  refreshQuestions();
  refreshVoters();
}

// Si un PIN est déjà enregistré (visite précédente), on va direct au
// panneau — le premier appel admin échouera vite s'il est périmé.
if (state.adminPin) {
  enterDashboard();
}

// ---------- formulaire question (création + modification partagent le même formulaire) ----------

function addOptionRow(value = '') {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.marginBottom = '8px';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = "Texte de l'option";
  row.appendChild(input);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-secondary';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    // On garde au moins 2 options pour une question personnalisée.
    if (el.optionsList.children.length > 2) row.remove();
  });
  row.appendChild(removeBtn);

  el.optionsList.appendChild(row);
}

function getOptionValues() {
  return Array.from(el.optionsList.querySelectorAll('input'))
    .map((i) => i.value.trim())
    .filter(Boolean);
}

function resetOptionsList(values = ['', '']) {
  el.optionsList.innerHTML = '';
  values.forEach((v) => addOptionRow(v));
}

el.questionType.addEventListener('change', () => {
  const isCustom = el.questionType.value === 'custom';
  el.optionsField.classList.toggle('hidden', !isCustom);
  if (isCustom && el.optionsList.children.length === 0) resetOptionsList();
});

el.addOptionBtn.addEventListener('click', () => addOptionRow());

function resetForm() {
  state.editingQuestionId = null;
  el.formTitle.textContent = 'Nouvelle question';
  el.saveQuestionBtn.textContent = 'Ajouter la question';
  el.cancelEditBtn.classList.add('hidden');
  el.questionText.value = '';
  el.questionType.value = 'standard';
  el.optionsField.classList.add('hidden');
  resetOptionsList();
  el.formError.classList.add('hidden');
}

el.cancelEditBtn.addEventListener('click', resetForm);

function startEdit(question) {
  state.editingQuestionId = question.id;
  el.formTitle.textContent = 'Modifier la question';
  el.saveQuestionBtn.textContent = 'Enregistrer les modifications';
  el.cancelEditBtn.classList.remove('hidden');
  el.questionText.value = question.text;
  el.questionType.value = question.type;
  if (question.type === 'custom') {
    el.optionsField.classList.remove('hidden');
    resetOptionsList(question.options && question.options.length ? question.options : ['', '']);
  } else {
    el.optionsField.classList.add('hidden');
    resetOptionsList();
  }
  el.formError.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

el.saveQuestionBtn.addEventListener('click', async () => {
  const text = el.questionText.value.trim();
  const type = el.questionType.value;
  const options = type === 'custom' ? getOptionValues() : undefined;

  el.formError.classList.add('hidden');
  if (!text) return showFormError('Le texte de la question est requis.');
  if (type === 'custom' && (!options || options.length < 2)) {
    return showFormError('Ajoute au moins 2 options.');
  }

  el.saveQuestionBtn.disabled = true;
  try {
    const body = { text, type, options };
    if (state.editingQuestionId) {
      await api(`/api/questions/${state.editingQuestionId}`, { method: 'PATCH', body, auth: true });
    } else {
      await api('/api/questions', { method: 'POST', body, auth: true });
    }
    resetForm();
    await refreshQuestions();
  } catch (err) {
    showFormError(err.message);
  } finally {
    el.saveQuestionBtn.disabled = false;
  }
});

function showFormError(message) {
  el.formError.textContent = message;
  el.formError.classList.remove('hidden');
}

// ---------- récupération + affichage des questions ----------

async function refreshQuestions() {
  state.questions = await api('/api/questions');

  const open = state.questions.find((q) => q.status === 'open');
  if (open && state.voteCounts[open.id] === undefined) {
    const res = await api(`/api/questions/${open.id}/vote-count`);
    state.voteCounts[open.id] = res.voteCount;
  }

  // Pour les questions déjà fermées (par ex. après un rechargement de page),
  // on récupère leur résultat final une fois, s'il n'est pas déjà en cache.
  for (const q of state.questions) {
    if (q.status === 'closed' && !state.finalResults[q.id]) {
      const res = await api(`/api/questions/${q.id}/results`);
      state.finalResults[q.id] = { tally: res.tally, total: res.total };
    }
  }

  renderAll();
}

function renderAll() {
  renderLiveSection();
  renderQuestionsList();
}

function renderLiveSection() {
  const open = state.questions.find((q) => q.status === 'open');
  if (!open) {
    el.liveSection.classList.add('hidden');
    return;
  }
  el.liveSection.classList.remove('hidden');
  el.liveQuestionText.textContent = open.text;
  const count = state.voteCounts[open.id] || 0;
  el.liveVoteCount.textContent = count;
  el.liveVoteCountLabel.textContent = count === 1 ? 'vote reçu' : 'votes reçus';
  el.closeQuestionBtn.onclick = () => closeQuestion(open.id);
}

function buildResultsBars(question, results) {
  const wrap = document.createElement('div');
  const tally = (results && results.tally) || {};
  const total = (results && results.total) || 0;

  const totalLine = document.createElement('div');
  totalLine.className = 'results-total';
  totalLine.textContent = `${total} voix au total`;
  wrap.appendChild(totalLine);

  const choices = question.type === 'standard' ? STANDARD_LABELS : question.options || [];
  for (const choice of choices) {
    const count = tally[choice] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;

    const row = document.createElement('div');
    row.className = 'result-row';

    const label = document.createElement('div');
    label.className = 'result-row-label';
    label.innerHTML = `<span>${escapeHtml(choice)}</span><span class="count">${count} (${pct}%)</span>`;
    row.appendChild(label);

    const track = document.createElement('div');
    track.className = 'result-bar-track';
    const fill = document.createElement('div');
    fill.className = 'result-bar-fill';
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    row.appendChild(track);

    wrap.appendChild(row);
  }
  return wrap;
}

function renderQuestionsList() {
  el.questionsList.innerHTML = '';
  el.questionsEmpty.classList.toggle('hidden', state.questions.length > 0);

  const STATUS_LABEL = { draft: 'Brouillon', open: 'Ouvert', closed: 'Fermé' };

  for (const q of state.questions) {
    const card = document.createElement('div');
    card.className = 'card';

    const badge = document.createElement('span');
    badge.className = `badge badge-${q.status}`;
    badge.textContent = STATUS_LABEL[q.status] || q.status;

    const title = document.createElement('h3');
    title.style.margin = '10px 0 4px';
    title.textContent = q.text;

    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent =
      q.type === 'standard' ? 'Standard (Oui / Non / Blanc)' : `Personnalisé : ${(q.options || []).join(', ')}`;

    card.appendChild(badge);
    card.appendChild(title);
    card.appendChild(meta);

    // Une question fermée affiche son résultat final avec le détail.
    if (q.status === 'closed' && state.finalResults[q.id]) {
      card.appendChild(buildResultsBars(q, state.finalResults[q.id]));
    }

    const actions = document.createElement('div');
    actions.className = 'btn-row';
    actions.style.marginTop = '12px';

    if (q.status === 'draft') {
      actions.appendChild(makeButton('Ouvrir', 'btn-primary', () => openQuestion(q.id)));
      actions.appendChild(makeButton('Modifier', 'btn-secondary', () => startEdit(q)));
      actions.appendChild(makeButton('Supprimer', 'btn-danger', () => deleteQuestion(q.id)));
    }

    if (actions.children.length > 0) card.appendChild(actions);
    el.questionsList.appendChild(card);
  }
}

function makeButton(text, className, onClick) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.className = className;
  btn.addEventListener('click', onClick);
  return btn;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- actions sur une question ----------

async function openQuestion(id) {
  try {
    await api(`/api/questions/${id}/open`, { method: 'POST', auth: true });
    // Pas de changement d'état local ici — c'est l'événement socket
    // 'question:open' (reçu aussi par cet onglet, le serveur diffuse à tout
    // le monde) qui met réellement l'interface à jour.
  } catch (err) {
    alert(err.message);
  }
}

async function closeQuestion(id) {
  try {
    await api(`/api/questions/${id}/close`, { method: 'POST', auth: true });
  } catch (err) {
    alert(err.message);
  }
}

async function deleteQuestion(id) {
  if (!confirm('Supprimer cette question ?')) return;
  try {
    await api(`/api/questions/${id}`, { method: 'DELETE', auth: true });
    await refreshQuestions();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- procurations ----------

async function refreshVoters() {
  state.voters = await api('/api/voters', { auth: true });
  renderVoters();
}

function renderVoters() {
  el.votersList.innerHTML = '';
  if (state.voters.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Aucune procuration enregistrée.';
    el.votersList.appendChild(p);
    return;
  }

  for (const voter of state.voters) {
    const row = document.createElement('div');
    row.className = 'voter-row';

    const info = document.createElement('div');
    info.className = 'voter-info';
    info.innerHTML = `<div class="name">${escapeHtml(voter.displayName)}</div><div class="weight">Poids : ${voter.weight}</div>`;

    const actions = document.createElement('div');
    actions.className = 'btn-row';

    const link = `${location.origin}/voter.html?token=${voter.token}`;
    actions.appendChild(
      makeButton('Copier le lien', 'btn-secondary', async () => {
        try {
          await navigator.clipboard.writeText(link);
        } catch {
          prompt('Copie ce lien :', link);
        }
      })
    );
    actions.appendChild(
      makeButton('Révoquer', 'btn-danger', async () => {
        if (!confirm(`Révoquer le lien de ${voter.displayName} ?`)) return;
        await api(`/api/voters/${voter.token}`, { method: 'DELETE', auth: true });
        await refreshVoters();
      })
    );

    row.appendChild(info);
    row.appendChild(actions);
    el.votersList.appendChild(row);
  }
}

el.createVoterBtn.addEventListener('click', async () => {
  const displayName = el.voterName.value.trim();
  const weight = parseInt(el.voterWeight.value, 10);

  el.voterFormError.classList.add('hidden');
  if (!displayName) return showVoterFormError('Le nom est requis.');
  if (!Number.isInteger(weight) || weight < 1) return showVoterFormError('Le poids doit être un nombre entier ≥ 1.');

  el.createVoterBtn.disabled = true;
  try {
    await api('/api/voters', { method: 'POST', body: { displayName, weight }, auth: true });
    el.voterName.value = '';
    el.voterWeight.value = '';
    await refreshVoters();
  } catch (err) {
    showVoterFormError(err.message);
  } finally {
    el.createVoterBtn.disabled = false;
  }
});

function showVoterFormError(message) {
  el.voterFormError.textContent = message;
  el.voterFormError.classList.remove('hidden');
}

// ---------- mises à jour en direct ----------

function connectSocket() {
  const socket = io();

  socket.on('connect', () => {
    el.connectionStatus.textContent = 'En direct';
  });
  socket.on('disconnect', () => {
    el.connectionStatus.textContent = 'Reconnexion…';
  });

  // Une question a été créée/modifiée/supprimée (par nous ou un autre
  // onglet admin) — le plus simple et sûr est de tout recharger.
  socket.on('questions:changed', refreshQuestions);

  socket.on('question:open', (question) => {
    upsertQuestionLocal(question);
    state.voteCounts[question.id] = 0;
    renderAll();
  });

  // Pendant que le vote est ouvert, seul le NOMBRE de votes est diffusé —
  // jamais le détail par choix (voir la demande du président).
  socket.on('vote-count:update', ({ questionId, voteCount }) => {
    state.voteCounts[questionId] = voteCount;
    renderAll();
  });

  socket.on('question:closed', ({ questionId, tally, total }) => {
    state.finalResults[questionId] = { tally, total };
    const q = state.questions.find((x) => x.id === questionId);
    if (q) q.status = 'closed';
    renderAll();
  });
}

function upsertQuestionLocal(question) {
  const idx = state.questions.findIndex((q) => q.id === question.id);
  if (idx >= 0) state.questions[idx] = { ...state.questions[idx], ...question };
  else state.questions.push(question);
}