// voter.js — the page people vote from, on their phone.
//
// Two identities:
//  - anonymous: a random id generated once and kept in localStorage — one
//    ballot (ballot 0), worth 1 vote.
//  - proxy link (?token=...): the token IS the identity. The server says
//    which ballots it holds (own vote + one per represented person, each
//    worth 1) and every ballot can be cast differently. The page never
//    claims a weight or a ballot count itself — the server decides.

const { api, escapeHtml, choicesOf, withEndsAt, paintCountdown, onTick, resultsBlock, setStatus, t, choiceLabel, onLang, mountLangSwitch } = window.AG;

const state = {
  token: new URLSearchParams(location.search).get('token'),
  voterId: null,
  identity: null, // { displayName, ballots } — proxy mode only
  ballots: [{ index: 0, label: null, own: true }],
  question: null, // the open question on screen, or null
  choices: {}, // ballot index -> choice saved on the server
  queue: Promise.resolve(),
  online: null, // socket state, for the header status
  closedView: null, // { question, tally, total } while the result card is shown
  lastStatus: null, // [key, kind] of the last vote status message
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

function renderBanner() {
  if (!state.identity) return;
  const others = state.ballots.filter((b) => !b.own).map((b) => b.label);
  el.proxyBannerText.innerHTML = t(others.length > 1 ? 'v.proxyBannerN' : 'v.proxyBanner1', {
    name: escapeHtml(state.identity.displayName),
    n: state.ballots.length,
    others: escapeHtml(others.join(', ')),
  });
}

function renderStatus() {
  if (state.online === null) setStatus(el.status, false, t('status.connecting'));
  else setStatus(el.status, state.online, t(state.online ? 'status.live' : 'status.reconnecting'));
}

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
    el.proxyVotesN.textContent = state.ballots.length;
    renderBanner();
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
      chip.textContent = choiceLabel(c);
      chip.dataset.choice = c;
      chip.addEventListener('click', () => cast(state.ballots.map((b) => ({ ballot: b.index, choice: c }))));
      el.sameChips.appendChild(chip);
    }
    el.ballotsWrap.innerHTML = '';
    for (const b of state.ballots) {
      const card = document.createElement('div');
      card.className = 'ballot';
      card.dataset.ballot = b.index;
      card.innerHTML =
        `<div class="ballot-head"><div class="ballot-who"><small data-i18n="${b.own ? 'v.ballotMine' : 'v.ballotProxy'}">${t(b.own ? 'v.ballotMine' : 'v.ballotProxy')}</small>` +
        `<b>${escapeHtml(b.label)}</b></div><span class="ballot-state"></span></div><div class="seg"></div>`;
      const seg = card.querySelector('.seg');
      for (const c of choices) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = choiceLabel(c);
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
      btn.textContent = choiceLabel(c);
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
    if (Object.keys(state.choices).length) setVoteStatus('saved', 'ok');
  } catch {
    /* not fatal: the page still works, just without the restored selection */
  }
}

function paintSelections(choices = state.choices) {
  if (isMulti()) {
    for (const card of el.ballotsWrap.querySelectorAll('.ballot')) {
      const chosen = choices[card.dataset.ballot];
      card.classList.toggle('saved', chosen !== undefined);
      card.querySelector('.ballot-state').textContent = t(chosen !== undefined ? 'v.ballotSaved' : 'v.ballotTodo');
      card.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('selected', b.dataset.choice === chosen));
    }
    const done = state.ballots.filter((b) => choices[b.index] !== undefined).length;
    el.progress.textContent = t('v.progress', { done, n: state.ballots.length });
  } else {
    el.single.querySelectorAll('.choice').forEach((b) => b.classList.toggle('selected', b.dataset.choice === choices[0]));
  }
}

function savedMessage() {
  if (!isMulti()) return t('v.savedSingle');
  const n = state.ballots.length;
  const done = state.ballots.filter((b) => state.choices[b.index] !== undefined).length;
  return done === n ? t('v.savedAll') : t('v.savedPartial', { done, n, left: n - done });
}

// `what`: '' (clear), 'saving', 'saved', or an error message (already translated).
function setVoteStatus(what, kind) {
  state.lastStatus = [what, kind];
  el.voteStatus.textContent = what === 'saving' ? t('v.saving') : what === 'saved' ? savedMessage() : what;
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
  setVoteStatus('saving');

  state.queue = state.queue.then(async () => {
    try {
      await api('/api/vote', { method: 'POST', body: { questionId: qid, ...identityBody(), votes } });
      if (!state.question || state.question.id !== qid) return;
      for (const v of votes) state.choices[v.ballot] = v.choice;
      paintSelections();
      setVoteStatus('saved', 'ok');
      if (navigator.vibrate) navigator.vibrate(15);
    } catch (err) {
      if (!state.question || state.question.id !== qid) return;
      paintSelections();
      setVoteStatus(err.message, 'err');
    }
  });
}

// ---------- closed: show the public result ----------

function showClosed(question, tally, total, animate = true) {
  state.closedView = { question, tally, total };
  el.closedText.textContent = question.text;
  el.closedResults.innerHTML = '';
  el.closedResults.appendChild(resultsBlock(question, tally, total, { donut: false, animate }));

  const mine = state.ballots.map((b) => state.choices[b.index]).filter((c) => c !== undefined);
  if (!mine.length) {
    el.closedMyVote.textContent = t('v.closedNone');
  } else if (!isMulti()) {
    el.closedMyVote.textContent = t('v.closedMine', { c: choiceLabel(mine[0]) });
  } else {
    const counts = {};
    mine.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    const missing = state.ballots.length - mine.length;
    el.closedMyVote.textContent =
      t('v.closedMineMulti', { list: Object.entries(counts).map(([c, n]) => `${choiceLabel(c)} ×${n}`).join(', ') }) +
      (missing ? t('v.closedNotCast', { n: missing }) : '');
  }
  showOnly(el.closed);
}

// ---------- live updates ----------

function connectSocket() {
  const socket = io();
  socket.on('connect', () => {
    state.online = true;
    renderStatus();
    syncCurrentQuestion();
  });
  socket.on('disconnect', () => {
    state.online = false;
    renderStatus();
  });

  socket.on('question:open', (q) => {
    state.closedView = null;
    showQuestion(q);
  });

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
    state.closedView = null;
    showOnly(el.waiting);
  });
}

onTick(() => {
  if (state.question) paintCountdown(el.countdown, state.question, { doneText: t('v.timeUp') });
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
        el.pushBtn.textContent = t('v.pushEnabled');
        el.pushBtn.removeAttribute('data-i18n');
      } catch (err) {
        el.pushBtn.disabled = false;
        alert(t('v.pushError') + err.message);
      }
    });
  } catch (err) {
    console.error('Service worker setup failed:', err);
  }
}

// ---------- language switch ----------

// Re-labels everything in place: the open question (keeping selections),
// the result card and the banner — nothing is re-fetched.
onLang(() => {
  document.title = t('v.pageTitle');
  renderStatus();
  renderBanner();
  if (state.question && !el.voting.classList.contains('hidden')) {
    el.voting.querySelectorAll('[data-choice]').forEach((b) => (b.textContent = choiceLabel(b.dataset.choice)));
    paintSelections();
    if (state.lastStatus) setVoteStatus(...state.lastStatus);
  }
  if (state.closedView && !el.closed.classList.contains('hidden')) {
    const { question, tally, total } = state.closedView;
    showClosed(question, tally, total, false);
  }
});

mountLangSwitch(document.getElementById('lang-switch'));
document.title = t('v.pageTitle');
renderStatus();
boot();
