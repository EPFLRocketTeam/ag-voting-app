// voter.js — page that people actually vote from, on their phone.
//
// Two identities are possible:
//  - anonymous: a random id generated once and kept in localStorage, always
//    worth exactly 1 vote (server-enforced, see server.js).
//  - proxy (procuration): the URL carries ?token=..., a personal link the
//    admin generated. The token IS the identity — no local id is generated
//    in this mode, and the vote's weight is resolved server-side from the
//    token, never claimed by this page.

const STANDARD_CHOICES = ['Oui', 'Non', 'Blanc'];

const state = {
  token: new URLSearchParams(location.search).get('token'),
  voterId: null,          // only used in anonymous mode
  identity: null,         // { displayName, weight } — only set in proxy mode
  currentQuestion: null,  // the open question, or null
  submitting: false,
};

const el = {
  connectionStatus: document.getElementById('connection-status'),
  proxyBanner: document.getElementById('proxy-banner'),
  invalidTokenState: document.getElementById('invalid-token-state'),
  waitingState: document.getElementById('waiting-state'),
  votingState: document.getElementById('voting-state'),
  closedState: document.getElementById('closed-state'),
  questionText: document.getElementById('question-text'),
  choices: document.getElementById('choices'),
  voteStatus: document.getElementById('vote-status'),
};

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Échec de la requête (${res.status})`);
  return data;
}

function randomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers without crypto.randomUUID.
  return 'voter-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function showOnly(section) {
  for (const s of [el.invalidTokenState, el.waitingState, el.votingState, el.closedState]) {
    s.classList.toggle('hidden', s !== section);
  }
}

// ---------- boot ----------

async function boot() {
  if (state.token) {
    try {
      state.identity = await api(`/api/voters/${state.token}`);
    } catch (err) {
      showOnly(el.invalidTokenState);
      return; // stop here — an invalid proxy link should not fall back to anonymous voting
    }
    el.proxyBanner.textContent = `Tu votes en tant que ${state.identity.displayName} — ton vote compte pour ${state.identity.weight} voix.`;
    el.proxyBanner.classList.remove('hidden');
  } else {
    state.voterId = localStorage.getItem('agVotingVoterId');
    if (!state.voterId) {
      state.voterId = randomId();
      localStorage.setItem('agVotingVoterId', state.voterId);
    }
  }

  connectSocket();
  await loadCurrentQuestion();
}

async function loadCurrentQuestion() {
  const questions = await api('/api/questions');
  const open = questions.find((q) => q.status === 'open');
  if (open) {
    showQuestion(open);
  } else {
    showOnly(el.waitingState);
  }
}

function showQuestion(question) {
  state.currentQuestion = question;
  el.questionText.textContent = question.text;
  el.voteStatus.textContent = '';

  const choices = question.type === 'standard' ? STANDARD_CHOICES : question.options || [];
  el.choices.innerHTML = '';
  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-btn';
    btn.textContent = choice;
    btn.addEventListener('click', () => vote(choice, btn));
    el.choices.appendChild(btn);
  }

  showOnly(el.votingState);
}

async function vote(choice, clickedBtn) {
  if (state.submitting || !state.currentQuestion) return;
  state.submitting = true;

  // Disable all choice buttons briefly to avoid a double-tap firing two
  // requests, and mark the tapped one as selected right away for instant
  // feedback (confirmed — or rolled back — once the request returns).
  const buttons = Array.from(el.choices.querySelectorAll('button'));
  buttons.forEach((b) => (b.disabled = true));
  buttons.forEach((b) => b.classList.toggle('selected', b === clickedBtn));

  try {
    const body = { questionId: state.currentQuestion.id, choice };
    if (state.token) body.token = state.token;
    else body.voterId = state.voterId;

    await api('/api/vote', { method: 'POST', body });
    el.voteStatus.textContent = 'Vote enregistré. Tu peux changer d\'avis tant que le vote est ouvert.';
  } catch (err) {
    el.voteStatus.textContent = err.message;
    buttons.forEach((b) => b.classList.remove('selected'));
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    state.submitting = false;
  }
}

// ---------- mises à jour en direct ----------

function connectSocket() {
  const socket = io();

  socket.on('connect', () => {
    el.connectionStatus.textContent = 'EPFL Rocket Team';
  });
  socket.on('disconnect', () => {
    el.connectionStatus.textContent = 'Connexion perdue — reconnexion…';
  });

  socket.on('question:open', (question) => {
    showQuestion(question);
  });

  socket.on('question:closed', ({ questionId }) => {
    if (state.currentQuestion && state.currentQuestion.id === questionId) {
      state.currentQuestion = null;
      showOnly(el.closedState);
    }
  });
}

boot();