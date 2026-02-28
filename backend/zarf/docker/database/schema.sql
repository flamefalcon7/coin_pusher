CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================================================
-- 1. accounts (replaces users)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS accounts (
    account_id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    display_name        TEXT          NOT NULL DEFAULT '',

    -- Three-currency balances
    balance_usdc        NUMERIC(20,6) NOT NULL DEFAULT 0,   -- on-chain deposit staging
    balance_play        NUMERIC(20,4) NOT NULL DEFAULT 0,   -- play credits (non-withdrawable)
    balance_cash        NUMERIC(20,4) NOT NULL DEFAULT 0,   -- cash credits (withdrawable)

    -- Role
    role                TEXT          NOT NULL DEFAULT 'user',

    -- Security
    totp_secret         TEXT          NOT NULL DEFAULT '',   -- encrypted TOTP seed, '' = unbound
    withdraw_locked_until TIMESTAMPTZ,                      -- lock withdrawals after sensitive changes

    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_balance_usdc_nonneg CHECK (balance_usdc >= 0),
    CONSTRAINT chk_balance_play_nonneg CHECK (balance_play >= 0),
    CONSTRAINT chk_balance_cash_nonneg CHECK (balance_cash >= 0)
);

-- ==========================================================================
-- 2. auth_providers (multi-login: wallet / email / google ...)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS auth_providers (
    provider_id         UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    provider_type       TEXT          NOT NULL,  -- 'wallet', 'email', 'google'
    provider_uid        TEXT          NOT NULL,  -- wallet: '0xabc...', email: 'user@example.com'
    metadata_json       JSONB         NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE(provider_type, provider_uid)
);

CREATE INDEX IF NOT EXISTS idx_auth_providers_account
    ON auth_providers(account_id);

-- ==========================================================================
-- 3. deposit_addresses (per-user per-chain HD-derived addresses)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS deposit_addresses (
    address_id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    chain               TEXT          NOT NULL,
    address             TEXT          NOT NULL,
    derivation_index    INT           NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE(chain, address),
    UNIQUE(chain, derivation_index)
);

CREATE INDEX IF NOT EXISTS idx_deposit_addresses_account
    ON deposit_addresses(account_id);

CREATE INDEX IF NOT EXISTS idx_deposit_addresses_chain_address
    ON deposit_addresses(chain, address);

-- ==========================================================================
-- 3b. deposits (on-chain deposit records)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS deposits (
    deposit_id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    chain               TEXT          NOT NULL DEFAULT 'base',
    amount              NUMERIC(20,6) NOT NULL,
    tx_hash             TEXT          NOT NULL UNIQUE,
    block_number        BIGINT        NOT NULL,
    from_address        TEXT          NOT NULL DEFAULT '',
    status              TEXT          NOT NULL DEFAULT 'confirmed',
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposits_account
    ON deposits(account_id);

-- ==========================================================================
-- 4. withdraw_requests (state machine)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS withdraw_requests (
    request_id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    amount_cash         NUMERIC(20,4) NOT NULL,
    amount_usdc         NUMERIC(20,6) NOT NULL,
    fee_usdc            NUMERIC(20,6) NOT NULL DEFAULT 0,
    chain               TEXT          NOT NULL,
    to_address          TEXT          NOT NULL,
    status              TEXT          NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending','review','approved','rejected',
            'submitted','confirmed','failed','refunded'
        )),
    tx_hash             TEXT,
    error_msg           TEXT,
    reviewed_by         UUID,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    submitted_at        TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_withdraw_requests_account_status
    ON withdraw_requests(account_id, status);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_pending
    ON withdraw_requests(status) WHERE status IN ('pending','review','approved','submitted');

-- ==========================================================================
-- 4b. sweeps (deposit address → hot wallet USDC consolidation)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS sweeps (
    sweep_id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    deposit_address_id  UUID          NOT NULL REFERENCES deposit_addresses(address_id),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    chain               TEXT          NOT NULL DEFAULT 'base',
    from_address        TEXT          NOT NULL,
    to_address          TEXT          NOT NULL,
    amount_usdc         NUMERIC(20,6) NOT NULL,
    gas_fund_tx_hash    TEXT,
    sweep_tx_hash       TEXT          UNIQUE,
    status              TEXT          NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','gas_funded','submitted','confirmed','failed')),
    error_msg           TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    confirmed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sweeps_account
    ON sweeps(account_id);
CREATE INDEX IF NOT EXISTS idx_sweeps_status
    ON sweeps(status) WHERE status IN ('pending','gas_funded','submitted');
CREATE INDEX IF NOT EXISTS idx_sweeps_deposit_address
    ON sweeps(deposit_address_id, status);

-- ==========================================================================
-- 5. accounting_logs
-- ==========================================================================
CREATE TABLE IF NOT EXISTS accounting_logs (
    log_id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    action_type         TEXT          NOT NULL CHECK (action_type IN (
        'DEPOSIT',
        'EXCHANGE_PLAY',
        'EXCHANGE_CASH_PLAY',
        'GAME_INSERT',
        'GAME_REWARD',
        'WITHDRAW',
        'WITHDRAW_REFUND',
        'WITHDRAW_FEE',
        'WITHDRAW_FEE_REFUND'
    )),
    amount              NUMERIC(20,6) NOT NULL,
    currency            TEXT          NOT NULL CHECK (currency IN ('USDC','PLAY','CASH')),
    reference_id        TEXT          NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_logs_unique_ref
    ON accounting_logs(action_type, reference_id) WHERE (reference_id != '');

CREATE INDEX IF NOT EXISTS idx_accounting_logs_account_created
    ON accounting_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_logs_reference
    ON accounting_logs(action_type, reference_id);

-- ==========================================================================
-- 7. auth_nonces (replay-protection for wallet login)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce       TEXT        PRIMARY KEY,
    address     TEXT        NOT NULL DEFAULT '',
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);

-- ==========================================================================
-- 8. indexer_state (unchanged)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS indexer_state (
    chain               TEXT          PRIMARY KEY,
    last_cursor         TEXT          NOT NULL DEFAULT '',
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ==========================================================================
-- 9. inventory (per-account key coins + scroll counts)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS inventory (
    account_id          UUID          PRIMARY KEY REFERENCES accounts(account_id),
    key_coins           INT           NOT NULL DEFAULT 0 CHECK (key_coins >= 0),
    scroll_shock        INT           NOT NULL DEFAULT 0 CHECK (scroll_shock >= 0),
    scroll_tornado      INT           NOT NULL DEFAULT 0 CHECK (scroll_tornado >= 0),
    scroll_explosion    INT           NOT NULL DEFAULT 0 CHECK (scroll_explosion >= 0),
    scroll_lightning    INT           NOT NULL DEFAULT 0 CHECK (scroll_lightning >= 0),
    scroll_super_push   INT           NOT NULL DEFAULT 0 CHECK (scroll_super_push >= 0),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ==========================================================================
-- 10. chest_opens (log of chest open results)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS chest_opens (
    open_id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    scroll_type         TEXT          NOT NULL,
    scroll_count        INT           NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
