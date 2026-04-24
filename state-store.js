import { initDb, pool } from "./db.js";

const STATE_KEY = "bot_state_v1";

function defaultState() {
  return {
    cash: 10000,
    positions: {},
    trades: [],
    lastRunAt: null,
    runCount: 0
  };
}

export async function loadState() {
  await initDb();

  const result = await pool.query(
    "SELECT state FROM bot_state WHERE state_key = $1",
    [STATE_KEY]
  );

  if (result.rows.length === 0) {
    const state = defaultState();
    await saveState(state);
    return state;
  }

  return {
    ...defaultState(),
    ...result.rows[0].state
  };
}

export async function saveState(state) {
  await initDb();

  await pool.query(
    `
      INSERT INTO bot_state (state_key, state, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET
        state = EXCLUDED.state,
        updated_at = NOW()
    `,
    [STATE_KEY, JSON.stringify(state)]
  );

  return state;
}
