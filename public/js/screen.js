// screen.js — projector view (/ecran). Read-only, no PIN: it shows only
// what is public anyway — the open question with its vote COUNT (never the
// breakdown), then the final result once the question is closed.

const { api, choicesOf, withEndsAt, remainingMs, fmtClock, onTick, resultsBlock, escapeHtml } = window.AG;

const $ = (id) => document.getElementById(id);
const views = { idle: $('view-idle'), open: $('view-open'), closed: $('view-closed') };
const joinUrl = `${location.origin}/`;
const RING_CIRC = 2 * Math.PI * 45;

const state = { mode: null, question: null, timerTotalMs: null };

function show(mode) {
  state.mode = mode;
  for (const [k, v] of Object.entries(views)) {
    if (k === mode) {
      v.classList.remove('hidden');
      // restart the entrance animation
      v.style.animation = 'none';
      void v.offsetWidth;
      v.style.animation = '';
    } else {
      v.classList.add('hidden');
    }
  }
  $('corner-join').classList.toggle('hidden', mode === 'idle');
}

function drawQr(canvas, size) {
  window.QRCode.toCanvas(canvas, joinUrl, { width: size, margin: 0, color: { dark: '#000000', light: '#ffffff' } }, () => {});
}

function renderQrs() {
  const h = window.innerHeight;
  drawQr($('idle-qr'), Math.round(h * 0.42));
  drawQr($('corner-qr'), Math.round(h * 0.11));
  const pretty = joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  $('idle-url').textContent = pretty;
  $('corner-url').textContent = pretty;
}

// ---------- views ----------

function renderOpen(question, voteCount) {
  state.question = withEndsAt(question);
  state.timerTotalMs = question.timerRemainingMs;
  const qEl = $('open-question');
  qEl.textContent = question.text;
  qEl.classList.toggle('long', question.text.length > 110);
  $('open-choices').innerHTML = choicesOf(question).map((c) => `<span>${escapeHtml(c)}</span>`).join('');
  setCount(voteCount || 0, false);
  paintRing();
  show('open');
}

function setCount(n, bump = true) {
  const c = $('open-count');
  c.textContent = n;
  $('open-count-label').textContent = n === 1 ? 'vote reçu' : 'votes reçus';
  if (bump) {
    c.classList.add('bump');
    setTimeout(() => c.classList.remove('bump'), 220);
  }
}

function paintRing() {
  const ring = $('ring');
  const ms = remainingMs(state.question);
  if (state.mode !== 'open' || ms == null) {
    ring.classList.add('hidden');
    return;
  }
  ring.classList.remove('hidden');
  const total = Math.max(state.timerTotalMs || 1, 1);
  const frac = Math.min(1, ms / total);
  const prog = $('ring-prog');
  prog.style.strokeDasharray = `${RING_CIRC}`;
  prog.style.strokeDashoffset = `${RING_CIRC * (1 - frac)}`;
  ring.classList.toggle('urgent', ms > 0 && ms <= 10000);
  $('ring-time').textContent = ms === 0 ? '0:00' : fmtClock(ms);
  $('ring-sub').textContent = ms === 0 ? 'Temps écoulé' : 'restant';
}
onTick(paintRing);

function renderClosed(question, tally, total, animate) {
  state.question = null;
  const qEl = $('closed-question');
  qEl.textContent = question.text;
  const box = $('closed-results');
  box.innerHTML = '';
  box.appendChild(resultsBlock(question, tally, total, { donut: true, animate }));
  show('closed');
}

async function sync() {
  try {
    const s = await api('/api/screen');
    if (s.mode === 'open') {
      if (state.mode === 'open' && state.question && state.question.id === s.question.id) {
        setCount(s.voteCount, false);
        state.question.timerRemainingMs = s.question.timerRemainingMs;
        withEndsAt(state.question);
      } else {
        renderOpen(s.question, s.voteCount);
      }
    } else if (s.mode === 'closed') {
      renderClosed(s.question, s.tally, s.total, state.mode !== 'closed');
    } else {
      state.question = null;
      show('idle');
    }
  } catch (err) {
    console.error(err);
  }
}

// ---------- live ----------

const socket = io();
socket.on('connect', sync);
socket.on('question:open', (q) => renderOpen(q, 0));
socket.on('vote-count:update', ({ questionId, voteCount }) => {
  if (state.mode === 'open' && state.question && state.question.id === questionId) setCount(voteCount);
});
socket.on('timer:update', ({ questionId, remainingMs: ms }) => {
  if (!state.question || state.question.id !== questionId) return;
  state.question.timerRemainingMs = ms;
  state.timerTotalMs = ms;
  withEndsAt(state.question);
  paintRing();
});
socket.on('question:closed', ({ questionId, tally, total }) => {
  const q = state.question && state.question.id === questionId ? state.question : null;
  if (q) renderClosed(q, tally, total, true);
  else sync();
});
socket.on('session:reset', () => {
  state.question = null;
  show('idle');
});
// A question edited/deleted while shown: just resync.
socket.on('questions:changed', () => {
  if (state.mode !== 'open') sync();
});

// ---------- fullscreen + cursor ----------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
$('fs-btn').addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement));

let idleTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle-cursor');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle-cursor'), 2500);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderQrs, 200);
});

renderQrs();
sync();
