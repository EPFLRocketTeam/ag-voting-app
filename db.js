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

    -- Web Push subscriptions (one row per browser that opted in) so a
    -- discreet notification can be sent when a question is revealed, even
    -- if the tab is in the background or the browser is closed. The whole
    -- subscription object is stored -- web-push needs it back verbatim when
    -- sending, not just the endpoint.
    -- Archived AGs: "Nouvelle AG" stores a full snapshot of the finished
    -- session here (questions, choices, final tallies) before clearing the
    -- live tables, so past results stay available for re-export.
    CREATE TABLE IF NOT EXISTS archives (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ---------- v2 migrations (idempotent, safe on an existing database) ----------
  await pool.query(`
    -- Proxy holders now vote separately for each person they represent:
    -- 'proxy_names' lists those people (one ballot each, in this order);
    -- ballot 0 is always the holder's own vote. 'weight' stays as the total
    -- number of ballots (1 + proxies) for older links created without names.
    ALTER TABLE voters ADD COLUMN IF NOT EXISTS proxy_names JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- Optional countdown for the open question.
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS timer_ends_at TIMESTAMPTZ;
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS timer_auto_close BOOLEAN NOT NULL DEFAULT false;
  `);

  // One vote row per (question, voter, ballot): a proxy holder casts one
  // ballot per represented person. Existing rows become ballot 0 (their old
  // weight is kept, so already-closed results don't change).
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'votes' AND column_name = 'ballot'
      ) THEN
        ALTER TABLE votes ADD COLUMN ballot INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_pkey;
        ALTER TABLE votes ADD PRIMARY KEY (question_id, voter_id, ballot);
      END IF;
    END $$;
  `);
}

module.exports = { pool, init };