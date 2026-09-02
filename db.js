// db.js — Postgres storage for questions, votes, and proxy ("procuration") voters.
//
// A connection pool + plain SQL, no ORM: the schema is small and staying
// close to the SQL keeps it easy to reason about during an AG.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Only needed against a Postgres that requires TLS (some managed hosts).
  // A local/self-hosted Postgres on the same server usually doesn't.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      -- 'standard' = fixed Oui/Non/Blanc, no options stored.
      -- 'custom'   = admin-provided list of options (2+), stored in 'options'.
      type TEXT NOT NULL CHECK (type IN ('standard', 'custom')),
      options JSONB,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
      order_index INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      opened_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS votes (
      question_id TEXT NOT NULL REFERENCES questions(id),
      voter_id TEXT NOT NULL,        -- random id (anonymous voter) or a proxy token (see 'voters')
      choice TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,  -- always server-assigned, never taken from the client
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (question_id, voter_id)
    );

    -- Proxy ("procuration") voters: each row is a personal, unguessable link
    -- the admin hands out privately (never posted publicly). Voting with a
    -- valid token counts for 'weight' votes instead of 1 — the weight is
    -- looked up here server-side, a voter can never claim it themselves.
    CREATE TABLE IF NOT EXISTS voters (
      token TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      weight INTEGER NOT NULL CHECK (weight >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, init };