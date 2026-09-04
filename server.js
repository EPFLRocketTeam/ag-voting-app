// server.js — REST API + realtime broadcast for the AG voting tool.
//
// Design: plain REST endpoints do the actual state changes (create/open/close
// a question, cast a vote); each handler then emits a Socket.IO event so
// every connected browser (admin dashboard, every voter's phone) updates
// live without polling. Sockets are push-only here — no vote is ever cast
// over a socket, only broadcast through one, which keeps the "what changed
// the database" logic in one place (the REST handlers).
//
// Proxy ("procuration") voting: a normal voter is anonymous (random id
// generated client-side, always worth 1 vote). A proxy holder instead uses a
// personal link containing a token the admin generated for them from the
// President's private list; the vote weight tied to that token lives only
// in the `voters` table and is looked up server-side — a client can never
// claim extra weight for itself, whatever it sends.

require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { pool, init } = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || 'changeme'; // set a real one in .env before deploying

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// The bare root URL (what people actually get sent — "vote.epfl-rocket-team.ch",
// not "…/voter.html") has no matching static file (no public/index.html), so
// without this it 404s. Voters are the intended audience at "/"; the admin
// panel stays reachable only at its own explicit /admin.html.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voter.html'));
});

// Wrap async route handlers so a thrown/rejected error reaches Express's
// error middleware instead of crashing the process or hanging the request.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- helpers ----------

const STANDARD_CHOICES = ['Oui', 'Non', 'Blanc'];

function questionRow(q) {
  return {
    id: q.id,
    text: q.text,
    type: q.type, // 'standard' (fixed Oui/Non/Blanc) or 'custom' (own options)
    options: q.options ?? null, // JSONB comes back already parsed; only set for 'custom'
    status: q.status,
    orderIndex: q.order_index,
  };
}

function choicesFor(q) {
  return q.type === 'standard' ? STANDARD_CHOICES : q.options || [];
}

async function getQuestion(id) {
  const { rows } = await pool.query('SELECT * FROM questions WHERE id = $1', [id]);
  return rows[0] || null;
}

async function tallyFor(questionId) {
  const { rows } = await pool.query(
    'SELECT choice, SUM(weight) as weighted_count FROM votes WHERE question_id = $1 GROUP BY choice',
    [questionId]
  );
  const tally = {};
  let total = 0;
  for (const row of rows) {
    const count = parseInt(row.weighted_count, 10); // pg returns SUM() as a string
    tally[row.choice] = count;
    total += count;
  }
  return { tally, total };
}

// How many individual vote rows (not weighted) are recorded for a question —
// used for the "N votes reçus" counter shown while a question is still open,
// deliberately without revealing the breakdown by choice.
async function voteRowCountFor(questionId) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM votes WHERE question_id = $1', [questionId]);
  return parseInt(rows[0].c, 10);
}

// simple shared-PIN auth for the admin/presenter endpoints — this isn't
// trying to be a real user auth system, just enough to stop a random voter
// from opening/closing questions from their phone.
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  if (token !== ADMIN_PIN) {
    return res.status(401).json({ error: 'PIN administrateur invalide ou manquant.' });
  }
  next();
}

// ---------- admin auth ----------

app.post('/api/admin/verify', (req, res) => {
  const { pin } = req.body || {};
  if (pin === ADMIN_PIN) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'PIN incorrect.' });
});

// ---------- questions ----------

app.get(
  '/api/questions',
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM questions ORDER BY order_index ASC');
    res.json(rows.map(questionRow));
  })
);

app.get(
  '/api/questions/:id',
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    res.json(questionRow(q));
  })
);

// Live vote count only (no breakdown) — safe to show while a question is
// still open, since it doesn't reveal which way the room is leaning.
app.get(
  '/api/questions/:id/vote-count',
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    const count = await voteRowCountFor(q.id);
    res.json({ questionId: q.id, voteCount: count });
  })
);

// Full breakdown with percentages — only meant to be shown once a question
// is closed (the frontend enforces that; the endpoint itself stays simple).
app.get(
  '/api/questions/:id/results',
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    const { tally, total } = await tallyFor(q.id);
    res.json({ question: questionRow(q), tally, total });
  })
);

app.post(
  '/api/questions',
  requireAdmin,
  wrap(async (req, res) => {
    const { text, type, options } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Le texte de la question est requis.' });
    }
    if (!['standard', 'custom'].includes(type)) {
      return res.status(400).json({ error: "type doit être 'standard' ou 'custom'." });
    }
    if (type === 'custom' && (!Array.isArray(options) || options.length < 2)) {
      return res.status(400).json({ error: 'Un choix personnalisé nécessite au moins 2 options.' });
    }

    const id = uuidv4();
    const { rows: orderRows } = await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 as next FROM questions');
    const orderIndex = orderRows[0].next;

    const { rows } = await pool.query(
      `INSERT INTO questions (id, text, type, options, status, order_index)
       VALUES ($1, $2, $3, $4, 'draft', $5)
       RETURNING *`,
      [id, text.trim(), type, type === 'custom' ? JSON.stringify(options) : null, orderIndex]
    );

    io.emit('questions:changed');
    res.status(201).json(questionRow(rows[0]));
  })
);

app.patch(
  '/api/questions/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    if (q.status !== 'draft') {
      return res.status(400).json({ error: 'Seules les questions en brouillon peuvent être modifiées.' });
    }
    const { text, type, options } = req.body || {};
    const newText = text !== undefined ? text.trim() : q.text;
    const newType = type !== undefined ? type : q.type;
    const newOptions = newType === 'custom' ? JSON.stringify(options ?? []) : null;

    const { rows } = await pool.query(
      'UPDATE questions SET text = $1, type = $2, options = $3 WHERE id = $4 RETURNING *',
      [newText, newType, newOptions, q.id]
    );
    io.emit('questions:changed');
    res.json(questionRow(rows[0]));
  })
);

app.delete(
  '/api/questions/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    // Draft or closed can be deleted (e.g. to clear out test questions after
    // a dry run) — only an OPEN question is blocked, since deleting one
    // mid-vote out from under connected voters would be genuinely confusing.
    if (q.status === 'open') {
      return res.status(400).json({ error: 'Ferme la question avant de la supprimer.' });
    }
    // votes.question_id references questions(id) without ON DELETE CASCADE,
    // so a closed question with votes attached must have them removed first
    // — otherwise Postgres rejects the delete with a foreign key violation.
    // Both deletes run in one transaction so we never end up with votes
    // orphaned by a question that got deleted (or vice versa) if something
    // fails halfway through.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM votes WHERE question_id = $1', [q.id]);
      await client.query('DELETE FROM questions WHERE id = $1', [q.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    io.emit('questions:changed');
    res.status(204).end();
  })
);

app.post(
  '/api/questions/:id/open',
  requireAdmin,
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    if (q.status === 'closed') {
      return res.status(400).json({ error: 'Cette question est déjà fermée.' });
    }

    // Only one question live at a time — close any other open one first.
    const { rows: openOthers } = await pool.query(
      "SELECT id FROM questions WHERE status = 'open' AND id != $1",
      [q.id]
    );
    for (const other of openOthers) {
      await pool.query("UPDATE questions SET status = 'closed', closed_at = now() WHERE id = $1", [other.id]);
      const { tally, total } = await tallyFor(other.id);
      io.emit('question:closed', { questionId: other.id, tally, total });
    }

    const { rows } = await pool.query(
      "UPDATE questions SET status = 'open', opened_at = now() WHERE id = $1 RETURNING *",
      [q.id]
    );
    io.emit('question:open', questionRow(rows[0]));
    res.json(questionRow(rows[0]));
  })
);

app.post(
  '/api/questions/:id/close',
  requireAdmin,
  wrap(async (req, res) => {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    if (q.status !== 'open') {
      return res.status(400).json({ error: 'Seule une question ouverte peut être fermée.' });
    }
    await pool.query("UPDATE questions SET status = 'closed', closed_at = now() WHERE id = $1", [q.id]);
    const { tally, total } = await tallyFor(q.id);
    io.emit('question:closed', { questionId: q.id, tally, total });
    res.json({ questionId: q.id, tally, total });
  })
);

// ---------- voting ----------

app.post(
  '/api/vote',
  wrap(async (req, res) => {
    const { questionId, voterId, choice, token } = req.body || {};
    if (!questionId || !choice) {
      return res.status(400).json({ error: 'questionId et choice sont requis.' });
    }
    const q = await getQuestion(questionId);
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });
    if (q.status !== 'open') {
      return res.status(400).json({ error: "Cette question n'est pas actuellement ouverte au vote." });
    }
    if (!choicesFor(q).includes(choice)) {
      return res.status(400).json({ error: 'Choix invalide pour cette question.' });
    }

    // Weight is NEVER taken from the request body — only from a server-side
    // lookup. Anonymous voters (no token) are always worth exactly 1 vote;
    // a proxy holder's weight comes only from their token's row in `voters`,
    // set up ahead of time by the admin from the President's private list.
    let rowId, weight;
    if (token) {
      const { rows } = await pool.query('SELECT * FROM voters WHERE token = $1', [token]);
      if (!rows[0]) {
        return res.status(403).json({ error: 'Lien de vote invalide ou expiré.' });
      }
      rowId = token;
      weight = rows[0].weight;
    } else {
      if (!voterId) return res.status(400).json({ error: 'voterId est requis pour un vote anonyme.' });
      rowId = voterId;
      weight = 1;
    }

    // One row per (question, voter) — voting again just overwrites the
    // previous choice, so someone can change their mind while the question
    // is still open.
    await pool.query(
      `INSERT INTO votes (question_id, voter_id, choice, weight) VALUES ($1, $2, $3, $4)
       ON CONFLICT (question_id, voter_id) DO UPDATE SET choice = EXCLUDED.choice, weight = EXCLUDED.weight, created_at = now()`,
      [questionId, rowId, choice, weight]
    );

    // Only the raw participation count is broadcast while voting is open —
    // never the breakdown by choice. Results stay hidden until a question
    // closes; this is a deliberate requirement, not just a UI choice.
    const voteCount = await voteRowCountFor(questionId);
    io.emit('vote-count:update', { questionId, voteCount });
    res.json({ ok: true, weight });
  })
);

// ---------- proxy ("procuration") voters ----------

// Public, deliberately unauthenticated: this is how the voter page resolves
// a personal ?token=... link to a name + weight to show the voter. It's
// safe precisely because it requires already knowing the exact, unguessable
// token — there is no way to list or enumerate voters through this route,
// only to look up the one you already hold (unlike GET /api/voters below,
// which lists everyone and stays admin-only).
app.get(
  '/api/voters/:token',
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM voters WHERE token = $1', [req.params.token]);
    if (!rows[0]) return res.status(404).json({ error: 'Lien de vote invalide.' });
    res.json({ displayName: rows[0].display_name, weight: rows[0].weight });
  })
);

app.get(
  '/api/voters',
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM voters ORDER BY created_at ASC');
    res.json(rows.map((v) => ({ token: v.token, displayName: v.display_name, weight: v.weight })));
  })
);

app.post(
  '/api/voters',
  requireAdmin,
  wrap(async (req, res) => {
    const { displayName, weight } = req.body || {};
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'Le nom est requis.' });
    }
    const weightNum = parseInt(weight, 10);
    if (!Number.isInteger(weightNum) || weightNum < 1) {
      return res.status(400).json({ error: 'Le poids doit être un entier >= 1.' });
    }

    const token = uuidv4();
    await pool.query('INSERT INTO voters (token, display_name, weight) VALUES ($1, $2, $3)', [
      token,
      displayName.trim(),
      weightNum,
    ]);
    res.status(201).json({ token, displayName: displayName.trim(), weight: weightNum });
  })
);

app.delete(
  '/api/voters/:token',
  requireAdmin,
  wrap(async (req, res) => {
    // Deliberately does not touch already-cast votes tied to this token —
    // revoking access shouldn't retroactively change a result that was
    // already part of a closed (or live) tally.
    await pool.query('DELETE FROM voters WHERE token = $1', [req.params.token]);
    res.status(204).end();
  })
);

// ---------- export (raw data the admin's PDF button builds from) ----------

// Admin-gated (unlike /api/questions/:id/results, which is left open — see
// the comment on that route): this endpoint dumps EVERY question at once,
// so it's the one place a stray URL guess would most easily hand someone
// the whole AG's results in one shot. Gating it costs nothing and matches
// the "results stay hidden while open" requirement more strictly.
//
// A question that isn't closed yet never gets a tally computed at all here
// (not just hidden client-side) — its breakdown by choice must not leak
// through this endpoint while voting is still in progress.
app.get(
  '/api/export/results',
  requireAdmin,
  wrap(async (req, res) => {
    const { rows: questions } = await pool.query('SELECT * FROM questions ORDER BY order_index ASC');
    const results = [];
    for (const q of questions) {
      if (q.status === 'closed') {
        const { tally, total } = await tallyFor(q.id);
        results.push({ ...questionRow(q), tally, total });
      } else {
        results.push({ ...questionRow(q), tally: null, total: null });
      }
    }
    res.json(results);
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Error middleware — must be registered last, after every route.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

io.on('connection', () => {
  // nothing to do on connect yet — clients just listen for broadcasts.
});

async function main() {
  try {
    await init();
  } catch (err) {
    console.error('Could not connect to Postgres / initialize schema:', err.message);
    console.error('Check DATABASE_URL in .env and that Postgres is running (see docker-compose.yml for local dev).');
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`AG voting tool listening on http://localhost:${PORT}`);
    if (ADMIN_PIN === 'changeme') {
      console.warn('WARNING: ADMIN_PIN is still the default. Set a real one in .env before using this for real.');
    }
  });
}

main();
