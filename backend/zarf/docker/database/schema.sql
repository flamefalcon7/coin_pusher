CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================================================
-- 1. accounts (replaces users)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS accounts (
    account_id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    display_name        TEXT,                                -- NULL = not set (show truncated address)

    -- Three-currency balances
    balance_usdc        NUMERIC(20,6) NOT NULL DEFAULT 0,   -- on-chain deposit staging
    balance_play        NUMERIC(20,4) NOT NULL DEFAULT 0,   -- play credits (non-withdrawable)
    balance_cash        NUMERIC(20,4) NOT NULL DEFAULT 0,   -- cash credits (withdrawable)

    -- Role
    role                TEXT          NOT NULL DEFAULT 'user',

    -- Referral system
    referral_code       TEXT          NOT NULL,              -- random default, customizable at $10 deposit
    referral_code_customized BOOLEAN NOT NULL DEFAULT FALSE,
    referred_by         UUID          REFERENCES accounts(account_id),
    referral_reward_paid BOOLEAN      NOT NULL DEFAULT FALSE,
    lifetime_deposit_usdc NUMERIC(20,6) NOT NULL DEFAULT 0, -- cumulative USDC deposited

    -- Security
    totp_secret         TEXT          NOT NULL DEFAULT '',   -- encrypted TOTP seed, '' = unbound
    withdraw_locked_until TIMESTAMPTZ,                      -- lock withdrawals after sensitive changes

    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_balance_usdc_nonneg CHECK (balance_usdc >= 0),
    CONSTRAINT chk_balance_play_nonneg CHECK (balance_play >= 0),
    CONSTRAINT chk_balance_cash_nonneg CHECK (balance_cash >= 0),
    CONSTRAINT chk_lifetime_deposit_nonneg CHECK (lifetime_deposit_usdc >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_referral_code
    ON accounts(LOWER(referral_code));
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_display_name
    ON accounts(LOWER(display_name)) WHERE display_name IS NOT NULL;

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
        'GAME_INSERT_REFUND',
        'GAME_REWARD',
        'CHEST_REWARD',
        'WITHDRAW',
        'WITHDRAW_REFUND',
        'WITHDRAW_FEE',
        'WITHDRAW_FEE_REFUND',
        'PROGRESS_REWARD',
        'REFERRAL_REWARD'
    )),
    amount              NUMERIC(20,6) NOT NULL,
    currency            TEXT          NOT NULL CHECK (currency IN ('USDC','PLAY','CASH')),
    reference_id        TEXT          NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Drop pre-split unique index that blocked mixed-currency GAME_INSERT entries
-- sharing a reference_id. Superseded by idx_accounting_logs_unique_ref_v2
-- which permits one PLAY + one CASH row per (action_type, reference_id).
DROP INDEX IF EXISTS idx_accounting_logs_unique_ref;

-- Uniqueness is per (action_type, reference_id, currency) so a split insert
-- can write one PLAY entry and one CASH entry under the same reference_id,
-- while still preventing duplicate inserts or refunds within the same currency.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_logs_unique_ref_v2
    ON accounting_logs(action_type, reference_id, currency) WHERE (reference_id != '');

CREATE INDEX IF NOT EXISTS idx_accounting_logs_account_created
    ON accounting_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_logs_reference
    ON accounting_logs(action_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_accounting_logs_action_created
    ON accounting_logs(action_type, created_at DESC);

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
    megaspeaker         INT           NOT NULL DEFAULT 0 CHECK (megaspeaker >= 0),
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

-- ==========================================================================
-- 11. progress (admin-defined promotion definitions)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS progress (
    progress_id         UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    title               TEXT          NOT NULL,
    description         TEXT          NOT NULL DEFAULT '',
    metric_type         TEXT          NOT NULL,
    threshold           NUMERIC(20,6) NOT NULL,
    reward_type         TEXT          NOT NULL,
    reward_amount       NUMERIC(20,6) NOT NULL,
    disburse_delay      INTERVAL      NOT NULL DEFAULT '0',
    claim_deadline      INTERVAL,                             -- NULL = no expiration
    active_from         TIMESTAMPTZ,
    active_until        TIMESTAMPTZ,
    enabled             BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_progress_metric_enabled
    ON progress(metric_type) WHERE enabled = TRUE;

-- ==========================================================================
-- 12. account_progress (per-user tracking for each progress)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS account_progress (
    account_id          UUID          NOT NULL REFERENCES accounts(account_id),
    progress_id         UUID          NOT NULL REFERENCES progress(progress_id),
    current_value       NUMERIC(20,6) NOT NULL DEFAULT 0,
    status              TEXT          NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','achieved','disbursed','expired')),
    achieved_at         TIMESTAMPTZ,
    disbursed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    PRIMARY KEY (account_id, progress_id)
);

CREATE INDEX IF NOT EXISTS idx_account_progress_disbursable
    ON account_progress(status, achieved_at) WHERE status = 'achieved';

-- ==========================================================================
-- 13. sponsor_campaigns (permissionless sponsor ad campaigns)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS sponsor_campaigns (
    campaign_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by     UUID NOT NULL REFERENCES accounts(account_id),
    chain          TEXT NOT NULL,
    token_address  TEXT NOT NULL,
    token_symbol   TEXT NOT NULL CHECK (token_symbol ~ '^[A-Z0-9]{1,10}$'),
    token_decimals INT NOT NULL CHECK (token_decimals BETWEEN 0 AND 18),
    brand_color    TEXT NOT NULL CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
    brand_name     TEXT NOT NULL CHECK (length(brand_name) BETWEEN 1 AND 32),
    logo_url       TEXT NOT NULL,
    ad_image_url   TEXT NOT NULL,
    pool_total     NUMERIC(38,18) NOT NULL CHECK (pool_total > 0),
    pool_remaining NUMERIC(38,18) NOT NULL CHECK (pool_remaining >= 0),
    reward_per_coin NUMERIC(38,18) NOT NULL CHECK (reward_per_coin > 0),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted', 'paused', 'expired')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT min_campaign_coins CHECK (pool_total / reward_per_coin >= 100)
);

CREATE INDEX IF NOT EXISTS idx_sponsor_campaigns_status ON sponsor_campaigns(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsor_campaigns_token ON sponsor_campaigns(chain, token_address) WHERE status = 'active';

-- ==========================================================================
-- 14. sponsor_quota_ledger (quota allocations from campaign pools)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS sponsor_quota_ledger (
    quota_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id    UUID NOT NULL REFERENCES sponsor_campaigns(campaign_id),
    coin_count     INT NOT NULL CHECK (coin_count > 0),
    coins_spawned  INT NOT NULL DEFAULT 0,
    token_amount   NUMERIC(38,18) NOT NULL,
    status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'refunded')),
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sponsor_quota_ledger_status ON sponsor_quota_ledger(status, issued_at);

-- ==========================================================================
-- 15. sponsor_balances (per-account per-campaign token balances)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS sponsor_balances (
    account_id    UUID NOT NULL REFERENCES accounts(account_id),
    campaign_id   UUID NOT NULL REFERENCES sponsor_campaigns(campaign_id),
    balance       NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, campaign_id)
);

-- ==========================================================================
-- 16. sponsor_reward_logs (individual reward distribution events)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS sponsor_reward_logs (
    log_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(account_id),
    campaign_id   UUID NOT NULL REFERENCES sponsor_campaigns(campaign_id),
    amount        NUMERIC(38,18) NOT NULL CHECK (amount > 0),
    ref_key       TEXT NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sponsor_reward_logs_account ON sponsor_reward_logs(account_id, campaign_id, created_at DESC);

-- ==========================================================================
-- 17. nats_outbox (transactional outbox for at-least-once NATS delivery)
-- ==========================================================================
-- Rows written inside the same tx as balance debits; drained by a background
-- worker that publishes to NATS and deletes on success. Closes the
-- "balance debited but event never published" gap that drives the
-- coinpusher_batch_insert_refund_failures_total P0 alert. See
-- docs/plans/2026-04-13-001-fix-batch-insert-outbox-plan.md.
CREATE TABLE IF NOT EXISTS nats_outbox (
    id                  BIGSERIAL     PRIMARY KEY,
    subject             TEXT          NOT NULL,
    payload             BYTEA         NOT NULL,
    reference_id        TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    attempt_count       INT           NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error          TEXT,
    last_attempted_at   TIMESTAMPTZ,
    payload_version     SMALLINT      NOT NULL DEFAULT 1
);

-- Partial index scoped to drainer-eligible rows. The drain query CTE is:
--   WITH ranked AS (
--     SELECT ..., ROW_NUMBER() OVER (PARTITION BY subject ORDER BY id) AS rn
--     FROM nats_outbox
--     WHERE attempt_count < 10 AND (last_attempted_at IS NULL OR backoff-elapsed)
--   )
-- Without a partial index on (subject, id) WHERE attempt_count < 10, Postgres
-- must scan the entire table to evaluate the WHERE predicate before the window
-- function can run — steady state is fine, but a sustained NATS outage that
-- accumulates a backlog forces a full seq-scan on every drain tick.
--
-- The partial predicate matches the drainer's MaxAttempts default (10). If
-- MaxAttempts changes at runtime, the index still covers the common case
-- because rows are deleted on success long before they accumulate.
CREATE INDEX IF NOT EXISTS idx_nats_outbox_drainable
    ON nats_outbox(subject, id)
    WHERE attempt_count < 10;

-- Cross-lookup with accounting_logs.reference_id for debug/audit.
CREATE INDEX IF NOT EXISTS idx_nats_outbox_reference
    ON nats_outbox(reference_id);

-- ==========================================================================
-- 18. nats_outbox_dlq (poison-pill quarantine for bounded retry)
-- ==========================================================================
-- Rows that reached attempt_count >= 10 in nats_outbox are moved here by the
-- drainer. Unblocks the subject so subsequent rows can drain, and surfaces the
-- failure via P1 alert on DLQ growth. Operator reviews moved_at DESC.
CREATE TABLE IF NOT EXISTS nats_outbox_dlq (
    id                  BIGSERIAL     PRIMARY KEY,
    original_id         BIGINT        NOT NULL,
    subject             TEXT          NOT NULL,
    payload             BYTEA         NOT NULL,
    reference_id        TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL,
    attempt_count       INT           NOT NULL,
    last_error          TEXT,
    last_attempted_at   TIMESTAMPTZ,
    payload_version     SMALLINT      NOT NULL DEFAULT 1,
    dlq_reason          TEXT          NOT NULL,
    moved_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nats_outbox_dlq_moved_at
    ON nats_outbox_dlq(moved_at DESC);
