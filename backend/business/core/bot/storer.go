package bot

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer declares the database operations required by the bot Core.
//
// The interface is narrow by design: only config CRUD, bot-account listing/
// filtering, and a single aggregate query for daily refill total. The refill
// write itself goes through accounting.Core.ProcessBotRefill — NOT through
// this storer — so the "which action, which currency" policy lives in one
// place and the tx + ledger + balance-credit flow is shared with
// ProcessDeposit.
type Storer interface {
	// QueryConfigAll returns the full bot_config key -> value map.
	// Callers that need a single key use this and pick from the map.
	QueryConfigAll(ctx context.Context) (map[string]string, error)

	// UpsertConfig writes (key, value) to bot_config, overwriting any existing
	// row. updated_at is set by the DB default.
	UpsertConfig(ctx context.Context, key, value string) error

	// QueryBotAccounts returns every account with role='bot'.
	// Intended for scheduler (once at startup, then in-memory) and admin list.
	QueryBotAccounts(ctx context.Context) ([]Bot, error)

	// QueryBotAccountByID returns the bot with the given account_id. Returns
	// v1.ErrNotFound if the account doesn't exist OR if it exists but has a
	// non-bot role — the caller can't distinguish and shouldn't need to.
	QueryBotAccountByID(ctx context.Context, accountID uuid.UUID) (Bot, error)

	// SumRefillsSince returns the sum of BOT_REFILL ledger amounts with
	// created_at >= since. Used by the scheduler to enforce the daily cap.
	SumRefillsSince(ctx context.Context, since time.Time) (decimal.Decimal, error)

	// QueryPausedAccountIDs returns the set of bot account_ids currently
	// flagged in bot_paused_accounts. The scheduler reads this per tick
	// (with a short cache) and skips paused bots in fireDueInserts and
	// adjustOnlineSet. Writes come from `admin bot pause`/`resume`.
	//
	// Returning a map rather than a slice lets callers do O(1) membership
	// checks during the per-bot tick loop.
	QueryPausedAccountIDs(ctx context.Context) (map[uuid.UUID]struct{}, error)
}
