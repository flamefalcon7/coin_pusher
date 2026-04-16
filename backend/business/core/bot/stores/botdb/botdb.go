// Package botdb provides PostgreSQL storage for the bot domain: bot_config
// upsert/read + bot-account listing/filtering + daily refill aggregation.
package botdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/bot"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for the bot domain.
type Store struct {
	db database.DBTX
}

// NewStore constructs a bot Store. Accepts the DBTX interface so a caller
// can bind to either a *sqlx.DB or an active *sqlx.Tx.
func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

// QueryConfigAll returns the full bot_config key/value map.
func (s *Store) QueryConfigAll(ctx context.Context) (map[string]string, error) {
	const q = `SELECT config_key, config_value FROM bot_config`

	rows := []struct {
		Key   string `db:"config_key"`
		Value string `db:"config_value"`
	}{}
	if err := s.db.SelectContext(ctx, &rows, q); err != nil {
		return nil, fmt.Errorf("selecting bot_config: %w", err)
	}

	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Key] = r.Value
	}
	return out, nil
}

// UpsertConfig inserts or updates a bot_config row. updated_at is set to NOW()
// on every call so admin CLI writes are observable in the audit trail.
func (s *Store) UpsertConfig(ctx context.Context, key, value string) error {
	const q = `
		INSERT INTO bot_config (config_key, config_value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (config_key)
		DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()`

	if _, err := s.db.ExecContext(ctx, q, key, value); err != nil {
		return fmt.Errorf("upserting bot_config[%s]: %w", key, err)
	}
	return nil
}

// QueryBotAccounts returns every account with role='bot'. The LEFT JOIN on
// auth_providers (filtered to provider_type='bot') picks the canonical bot
// provider row — a bot account should have exactly one such row per the
// seeder contract.
func (s *Store) QueryBotAccounts(ctx context.Context) ([]bot.Bot, error) {
	const q = `
		SELECT
			a.account_id   AS account_id,
			a.display_name AS display_name,
			COALESCE(ap.provider_uid, '') AS provider_uid,
			a.balance_play AS balance_play,
			a.balance_cash AS balance_cash,
			a.created_at   AS created_at
		FROM accounts a
		LEFT JOIN auth_providers ap
			ON ap.account_id = a.account_id
			AND ap.provider_type = $1
		WHERE a.role = $2
		ORDER BY a.created_at ASC`

	var bots []bot.Bot
	if err := s.db.SelectContext(ctx, &bots, q, user.ProviderTypeBot, user.RoleBot); err != nil {
		return nil, fmt.Errorf("selecting bot accounts: %w", err)
	}
	return bots, nil
}

// QueryBotAccountByID returns the bot account with the given ID. Returns a
// v1 NotFoundError if the account doesn't exist OR if it exists but is not
// role='bot' — callers can't distinguish and shouldn't need to.
func (s *Store) QueryBotAccountByID(ctx context.Context, accountID uuid.UUID) (bot.Bot, error) {
	const q = `
		SELECT
			a.account_id   AS account_id,
			a.display_name AS display_name,
			COALESCE(ap.provider_uid, '') AS provider_uid,
			a.balance_play AS balance_play,
			a.balance_cash AS balance_cash,
			a.created_at   AS created_at
		FROM accounts a
		LEFT JOIN auth_providers ap
			ON ap.account_id = a.account_id
			AND ap.provider_type = $1
		WHERE a.account_id = $2 AND a.role = $3
		LIMIT 1`

	var b bot.Bot
	if err := s.db.GetContext(ctx, &b, q, user.ProviderTypeBot, accountID, user.RoleBot); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return bot.Bot{}, v1.NewNotFoundError()
		}
		return bot.Bot{}, fmt.Errorf("selecting bot account %s: %w", accountID, err)
	}
	return b, nil
}

// SumRefillsSince returns the sum of BOT_REFILL ledger amounts with
// created_at >= since. Currency is implicitly PLAY — bots only ever receive
// refills into balance_play — but the filter is explicit for audit clarity.
func (s *Store) SumRefillsSince(ctx context.Context, since time.Time) (decimal.Decimal, error) {
	const q = `
		SELECT COALESCE(SUM(amount), 0)
		FROM accounting_logs
		WHERE action_type = $1
			AND currency = $2
			AND created_at >= $3`

	var total decimal.Decimal
	if err := s.db.GetContext(ctx, &total, q, accounting.ActionBotRefill, accounting.CurrencyPlay, since); err != nil {
		return decimal.Zero, fmt.Errorf("summing bot refills since %v: %w", since, err)
	}
	return total, nil
}

// QueryPausedAccountIDs returns the set of bot account_ids currently in
// bot_paused_accounts. Scheduler calls this per tick (cache-fronted) to
// exclude paused bots from the eligible pool.
func (s *Store) QueryPausedAccountIDs(ctx context.Context) (map[uuid.UUID]struct{}, error) {
	const q = `SELECT account_id FROM bot_paused_accounts`

	var ids []uuid.UUID
	if err := s.db.SelectContext(ctx, &ids, q); err != nil {
		return nil, fmt.Errorf("querying paused bot account_ids: %w", err)
	}
	out := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		out[id] = struct{}{}
	}
	return out, nil
}
