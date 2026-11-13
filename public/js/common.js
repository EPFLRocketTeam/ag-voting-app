// common.js — small helpers shared by the voter page, the admin panel and
// the projector screen. Exposed as window.AG (no build step, no modules).

window.AG = (() => {
  const STANDARD_CHOICES = ['Oui', 'Non', 'Blanc'];

  // Result colours, readable on black and on a projector.
  const COLORS = ['#da291c', '#f6f6f6', '#6e6e75', '#ff8a5c', '#8f1d14', '#b9b9bf', '#ffc2ad', '#45454b'];
  const color = (i) => COLORS[i % COLORS.length];

  const choicesOf = (q) => (q.type === 'standard' ? STANDARD_CHOICES : q.options || []);

  async function api(path, { method = 'GET', body, pin } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (pin) headers['x-admin-token'] = pin;
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `Échec de la requête (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- countdown ----------
  // The server sends "milliseconds left" (not an absolute time), so the end
  // is pinned to THIS device's clock on arrival — a phone with a wrong clock
  // still counts down correctly.
  function withEndsAt(q) {
    if (!q) return q;
    q.timerEndsAt = q.timerRemainingMs != null ? Date.now() + q.timerRemainingMs : null;
    return q;
  }
  function remainingMs(q) {
    if (!q || q.timerEndsAt == null) return null;
    return Math.max(0, q.timerEndsAt - Date.now());
  }
  function fmtClock(ms) {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  // Fills a .countdown element for a question (or hides it).
  function paintCountdown(elem, q, { doneText = 'Temps écoulé' } = {}) {
    const ms = remainingMs(q);
    if (ms == null) {
      elem.classList.add('hidden');
      return;
    }
    elem.classList.remove('hidden');
    elem.classList.toggle('urgent', ms > 0 && ms <= 10000);
    elem.classList.toggle('done', ms === 0);
    elem.textContent = ms === 0 ? doneText : fmtClock(ms);
  }
  const tickers = new Set();
  setInterval(() => tickers.forEach((fn) => fn()), 250);
  const onTick = (fn) => tickers.add(fn);

  // ---------- results: donut + bars ----------
  // `animate`: start empty, then grow on the next frame (used for reveals).
  function resultsBlock(question, tally, total, { donut = true, animate = false } = {}) {
    tally = tally || {};
    total = total || 0;
    const choices = choicesOf(question);
    const max = Math.max(0, ...choices.map((c) => tally[c] || 0));
    const leaders = choices.filter((c) => (tally[c] || 0) === max);
    const winner = max > 0 && leaders.length === 1 ? leaders[0] : null;

    const wrap = document.createElement('div');
    wrap.className = 'results' + (donut ? ' with-donut' : '');

    const finals = [];
    if (donut) {
      const r = 60;
      const circ = 2 * Math.PI * r;
      const d = document.createElement('div');
      d.className = 'donut';
      let svg = `<svg viewBox="0 0 150 150"><circle cx="75" cy="75" r="${r}" stroke="#242427"></circle>`;
      let offset = 0;
      choices.forEach((c, i) => {
        const frac = total > 0 ? (tally[c] || 0) / total : 0;
        if (frac <= 0) return;
        const len = frac * circ;
        finals.push({ idx: finals.length, len, circ, offset });
        svg += `<circle data-seg cx="75" cy="75" r="${r}" stroke="${color(i)}" style="stroke-dasharray:${animate ? 0 : len} ${circ};stroke-dashoffset:${-offset}"></circle>`;
        offset += len;
      });
      svg += '</svg>';
      d.innerHTML = `${svg}<div class="donut-center"><b>${total}</b><span>voix</span></div>`;
      wrap.appendChild(d);
    }

    const bars = document.createElement('div');
    bars.className = 'bars';
    const widths = [];
    choices.forEach((c, i) => {
      const count = tally[c] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      widths.push(pct);
      const row = document.createElement('div');
      row.className = 'bar-row' + (c === winner ? ' winner' : '');
      row.innerHTML =
        `<div class="bar-label"><span class="name"><i style="background:${color(i)}"></i>${escapeHtml(c)}</span>` +
        `<span class="val">${count} · ${pct}%</span></div>` +
        `<div class="bar-track"><div class="bar-fill" style="background:${color(i)};width:${animate ? 0 : pct}%"></div></div>`;
      bars.appendChild(row);
    });
    const tot = document.createElement('div');
    tot.className = 'results-total';
    tot.textContent = `${total} voix exprimée${total > 1 ? 's' : ''}`;
    bars.appendChild(tot);
    wrap.appendChild(bars);

    if (animate) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          wrap.querySelectorAll('.bar-fill').forEach((f, i) => (f.style.width = `${widths[i]}%`));
          wrap.querySelectorAll('circle[data-seg]').forEach((c, i) => {
            const s = finals[i];
            c.style.strokeDasharray = `${s.len} ${s.circ}`;
          });
        })
      );
    }
    return wrap;
  }

  function toast(message) {
    let t = document.getElementById('ag-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ag-toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }

  async function copy(text, okMessage = 'Lien copié') {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      prompt('Copie ce lien :', text);
    }
  }

  function setStatus(elem, online, text) {
    elem.classList.toggle('online', online);
    elem.classList.toggle('offline', !online);
    elem.textContent = text;
  }

  return { STANDARD_CHOICES, color, choicesOf, api, escapeHtml, withEndsAt, remainingMs, fmtClock, paintCountdown, onTick, resultsBlock, toast, copy, setStatus };
})();
