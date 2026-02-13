CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    user_id       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          TEXT        NOT NULL DEFAULT '',
    sui_address   TEXT        UNIQUE NOT NULL,
    zklogin_sub   TEXT        NOT NULL DEFAULT '',
    balance_coin  NUMERIC(20,4) NOT NULL DEFAULT 0,
    balance_usdc  NUMERIC(20,6) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounting_logs (
    log_id        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID        NOT NULL REFERENCES users(user_id),
    action_type   TEXT        NOT NULL CHECK (action_type IN ('DEPOSIT','WITHDRAW','GAME_INSERT','GAME_REWARD')),
    amount        NUMERIC(20,6) NOT NULL,
    currency      TEXT        NOT NULL CHECK (currency IN ('USDC','COIN')),
    reference_id  TEXT        NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(action_type, reference_id) WHERE (reference_id != '')
);

CREATE TABLE IF NOT EXISTS indexer_state (
    chain         TEXT        PRIMARY KEY,
    last_cursor   TEXT        NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_accounting_logs_user_created ON accounting_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_logs_reference ON accounting_logs(action_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_users_sui_address ON users(sui_address);
