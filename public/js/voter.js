// voter.js — the page people vote from, on their phone.
//
// Two identities:
//  - anonymous: a random id generated once and kept in localStorage — one
//    ballot (ballot 0), worth 1 vote.
//  - proxy link (?token=...): the token IS the identity. The server says
//    which ballots it holds (own vote + one per represented person, each
//    worth 1) and every ballot can be cast differently. The page never
//    claims a weight or a ballot count itself — the server decides.

const { api, escapeHtml, choicesOf, withEndsAt, paintCountdown, onTick, resultsBlock, setStatus } = window.AG;

const state = {
  token: new URLSearchParams(location.search).get('token'),
  voterId: null,
  identity: null, // { displayName, ballots } — proxy mode only
  ballots: [{ index: 0, label: null, own: true }],
  question: null, // the open question on screen, or null
  choices: {}, // ballot index -> choice saved on the server
  queue: Promise.resolve(),
};

const $ = (id) => document.getElementById(id);
const el = {
  status: $('connection-status'),
  pushBtn: $('enable-push-btn'),
  proxyBanner: $('proxy-banner'),
  proxyVotesN: $('proxy-votes-n'),
  proxyBannerText: $('proxy-banner-text'),
  invalid: $('invalid-token-state'),
  waiting: $('waiting-state'),
  voting: $('voting-state'),
  closed: $('closed-state'),
  countdown: $('countdown'),
  questionText: $('question-text'),
  single: $('single-ballot'),
  multi: $('multi-ballot'),
  sameChips: $('same-for-all-chips'),
  ballotsWrap: $('ballots'),
  progress: $('ballots-progress'),
  voteStatus: $('vote-status'),
  closedText: $('closed-question-text'),
  closedResults: $('closed-results'),
  closedMyVote: $('closed-my-vote'),
};

const isMulti = () => state.ballots.length > 1;

function showOnly(section) {
  for (const s of [el.invalid, el.waiting, el.voting, el.closed]) s.classList.toggle('hidden', s !== section);
}

function identityBody() {
  return state.token ? { token: state.token } : { voterId: state.voterId };
}

function randomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'voter-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- boot ----------

async function boot() {
  if (state.token) {
    try {
      state.identity = await api(`/api/voters/${encodeURIComponent(state.token)}`);
    } catch {
      showOnly(el.invalid);
      return; // an invalid proxy link must not fall back to anonymous voting
    }
    state.ballots = state.identity.ballots;
    const others = state.ballots.filter((b) => !b.own).map((b) => b.label);
    el.proxyVotesN.textContent = state.ballots.length;
    el.proxyBannerText.innerHTML =
      `<strong>${escapeHtml(state.identity.displayName)}</strong>, tu disposes de ${state.ballots.length} voix : ` +
      `la tienne et ${others.length > 1 ? 'celles de' : 'celle de'} ${escapeHtml(others.join(', '))}. ` +
      `<span class="muted">Chaque voix peut être votée différemment.</span>`;
    el.proxyBanner.classList.remove('hidden');
  } else {
    try {
      state.voterId = localStorage.getItem('agVotingVoterId');
      if (!state.voterId) {
        state.voterId = randomId();
        localStorage.setItem('agVotingVoterId', state.voterId);
      }
    } catch {
      state.voterId = state.voterId || randomId();
    }
  }

  connectSocket();
  setupPush();
  await syncCurrentQuestion();
}

// Fetches the open question (on load and after every reconnect, so events
// missed while offline never leave the page stale).
async function syncCurrentQuestion() {
  let questions;
  try {
    questions = await api('/api/questions');
  } catch {
    return;
  }
  const open = questions.find((q) => q.status === 'open');
  if (!open) {
    state.question = null;
    if (el.closed.classList.contains('hidden')) showOnly(el.waiting);
    return;
  }
  if (state.question && state.question.id === open.id) {
    state.question.timerRemainingMs = open.timerRemainingMs;
    withEndsAt(state.question);
    await loadMyVotes();
    return;
  }
  showQuestion(open);
}

// ---------- rendering the open question ----------

function showQuestion(question) {
  state.question = withEndsAt(question);
  state.choices = {};
  el.questionText.textContent = question.text;
  setVoteStatus('');
  paintCountdown(el.countdown, state.question);

  const choices = choicesOf(question);
  if (isMulti()) {
    el.single.classList.add('hidden');
    el.multi.classList.remove('hidden');
    el.sameChips.innerHTML = '';
    for (const c of choices) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = c;
      chip.addEventListener('click', () => cast(state.ballots.map((b) => ({ ballot: b.index, choice: c }))));
      el.sameChips.appendChild(chip);
    }
    el.ballotsWrap.innerHTML = '';
    for (const b of state.ballots) {
      const card = document.createElement('div');
      card.className = 'ballot';
      card.dataset.ballot = b.index;
      card.innerHTML =
        `<div class="ballot-head"><div class="ballot-who"><small>${b.own ? 'Ma voix' : 'Procuration'}</small>` +
        `<b>${escapeHtml(b.label)}</b></div><span class="ballot-state">À voter</span></div><div class="seg"></div>`;
      const seg = card.querySelector('.seg');
      for (const c of choices) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = c;
        btn.dataset.choice = c;
        btn.addEventListener('click', () => cast([{ ballot: b.index, choice: c }]));
        seg.appendChild(btn);
      }
      el.ballotsWrap.appendChild(card);
    }
  } else {
    el.multi.classList.add('hidden');
    el.single.classList.remove('hidden');
    el.single.innerHTML = '';
    for (const c of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';
      btn.textContent = c;
      btn.dataset.choice = c;
      btn.addEventListener('click', () => cast([{ ballot: 0, choice: c }]));
      el.single.appendChild(btn);
    }
  }
  paintSelections();
  showOnly(el.voting);
  loadMyVotes();
}

async function loadMyVotes() {
  if (!state.question) return;
  const qid = state.question.id;
  const params = new URLSearchParams({ questionId: qid, ...identityBody() });
  try {
    const { choices } = await api(`/api/my-votes?${params}`);
    if (!state.question || state.question.id !== qid) return;
    state.choices = { ...choices };
    paintSelections();
    if (Object.keys(state.choices).length) setVoteStatus(savedMessage(), 'ok');
  } catch {
    /* not fatal: the page still works, just without the restored selection */
  }
}

function paintSelections(choices = state.choices) {
  if (isMulti()) {
    for (const card of el.ballotsWrap.querySelectorAll('.ballot')) {
      const chosen = choices[card.dataset.ballot];
      card.classList.toggle('saved', chosen !== undefined);
      card.querySelector('.ballot-state').textContent = chosen !== undefined ? '✓ Enregistré' : 'À voter';
      card.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('selected', b.dataset.choice === chosen));
    }
    const done = state.ballots.filter((b) => choices[b.index] !== undefined).length;
    el.progress.textContent = `${done} / ${state.ballots.length} voix exprimées`;
  } else {
    el.single.querySelectorAll('.choice').forEach((b) => b.classList.toggle('selected', b.dataset.choice === choices[0]));
  }
}

function savedMessage() {
  if (!isMulti()) return "Vote enregistré. Tu peux changer d'avis tant que le vote est ouvert.";
  const done = state.ballots.filter((b) => state.choices[b.index] !== undefined).length;
  return done === state.ballots.length
    ? "Toutes tes voix sont enregistrées. Tu peux encore les modifier tant que le vote est ouvert."
    : `${done} voix sur ${state.ballots.length} enregistrée${done > 1 ? 's' : ''} — il en reste ${state.ballots.length - done}.`;
}

function setVoteStatus(text, kind) {
  el.voteStatus.textContent = text;
  el.voteStatus.className = 'vote-status' + (kind ? ` ${kind}` : '');
}

// ---------- casting ----------

// Requests go out one after another (queued), so quick successive taps are
// applied on the server in the same order they were made on screen.
function cast(votes) {
  if (!state.question) return;
  const qid = state.question.id;
  const optimistic = { ...state.choices };
  for (const v of votes) optimistic[v.ballot] = v.choice;
  paintSelections(optimistic);
  setVoteStatus('Enregistrement…');

  state.queue = state.queue.then(async () => {
    try {
      await api('/api/vote', { method: 'POST', body: { questionId: qid, ...identityBody(), votes } });
      if (!state.question || state.question.id !== qid) return;
      for (const v of votes) state.choices[v.ballot] = v.choice;
      paintSelections();
      setVoteStatus(savedMessage(), 'ok');
      if (navigator.vibrate) navigator.vibrate(15);
    } catch (err) {
      if (!state.question || state.question.id !== qid) return;
      paintSelections();
      setVoteStatus(err.message, 'err');
    }
  });
}

// ---------- closed: show the public result ----------

function showClosed(question, tally, total) {
  el.closedText.textContent = question.text;
  el.closedResults.innerHTML = '';
  el.closedResults.appendChild(resultsBlock(question, tally, total, { donut: false, animate: true }));

  const mine = state.ballots.map((b) => state.choices[b.index]).filter((c) => c !== undefined);
  if (!mine.length) {
    el.closedMyVote.textContent = "Tu n'as pas voté sur cette question.";
  } else if (!isMulti()) {
    el.closedMyVote.textContent = `Ton vote : ${mine[0]}`;
  } else {
    const counts = {};
    mine.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    el.closedMyVote.textContent =
      'Tes voix : ' + Object.entries(counts).map(([c, n]) => `${c} ×${n}`).join(', ') +
      (mine.length < state.ballots.length ? ` (${state.ballots.length - mine.length} non exprimée${state.ballots.length - mine.length > 1 ? 's' : ''})` : '');
  }
  showOnly(el.closed);
}

// ---------- live updates ----------

function connectSocket() {
  const socket = io();
  socket.on('connect', () => {
    setStatus(el.status, true, 'En direct');
    syncCurrentQuestion();
  });
  socket.on('disconnect', () => setStatus(el.status, false, 'Reconnexion…'));

  socket.on('question:open', (q) => showQuestion(q));

  socket.on('timer:update', ({ questionId, remainingMs }) => {
    if (!state.question || state.question.id !== questionId) return;
    state.question.timerRemainingMs = remainingMs;
    withEndsAt(state.question);
    paintCountdown(el.countdown, state.question);
  });

  socket.on('question:closed', ({ questionId, tally, total }) => {
    if (!state.question || state.question.id !== questionId) return;
    const q = state.question;
    state.question = null;
    showClosed(q, tally, total);
  });

  socket.on('session:reset', () => {
    state.question = null;
    showOnly(el.waiting);
  });
}

onTick(() => {
  if (state.question) paintCountdown(el.countdown, state.question, { doneText: 'Temps écoulé — clôture imminente' });
});

// ---------- push notifications (opt-in) ----------

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from([...atob(base64)].map((c) => c.charCodeAt(0)));
}

async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (await reg.pushManager.getSubscription()) return;
    const { publicKey } = await api('/api/push/public-key');
    if (!publicKey) return;
    el.pushBtn.classList.remove('hidden');
    el.pushBtn.addEventListener('click', async () => {
      el.pushBtn.disabled = true;
      try {
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
        await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
        el.pushBtn.textContent = 'Notifications activées';
      } catch (err) {
        el.pushBtn.disabled = false;
        alert("Impossible d'activer les notifications : " + err.message);
      }
    });
  } catch (err) {
    console.error('Service worker setup failed:', err);
  }
}

boot();
