const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

    -- Added for the "afficher/masquer" feature: a question can be open
    -- (accepting votes) while still hidden from voters, until the admin
    -- explicitly reveals it -- lets everyone look at their phone at the
    -- same moment.
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT false;

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

    -- Single-row settings table (id is always 'main') for things the admin
    -- configures once per AG rather than per question — currently just the
    -- quorum target. Kept separate from 'voters' since it isn't per-person.
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY DEFAULT 'main',
      expected_voters INTEGER,
      quorum_threshold_percent INTEGER NOT NULL DEFAULT 50
    );

    -- Web Push subscriptions (one row per browser that opted in) so a
    -- discreet notification can be sent when a question is revealed, even
    -- if the tab is in the background or the browser is closed. The whole
    -- subscription object is stored -- web-push needs it back verbatim when
    -- sending, not just the endpoint.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`INSERT INTO settings (id) VALUES ('main') ON CONFLICT (id) DO NOTHING`);
}

module.exports = { pool, init };