// SUI chain event indexer service.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ardanlabs/conf/v3"
	"github.com/jmoiron/sqlx"
	"go.uber.org/zap"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	ledgerdb "github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/foundation/blockchain/sui"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
	"github.com/flamefalcon/coin-pusher/backend/foundation/logger"
)

type config struct {
	DB struct {
		User       string `conf:"default:postgres"`
		Password   string `conf:"default:postgres,mask"`
		Host       string `conf:"default:localhost:5432"`
		Name       string `conf:"default:coinpusher"`
		DisableTLS bool   `conf:"default:true"`
	}
	SUI struct {
		RPCURL    string `conf:"default:https://fullnode.testnet.sui.io:443"`
		PackageID string `conf:"required"`
	}
	Indexer struct {
		PollInterval time.Duration `conf:"default:5s"`
		BatchSize    int           `conf:"default:50"`
		Chain        string        `conf:"default:sui-testnet"`
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	var cfg config
	help, err := conf.Parse("INDEXER", &cfg)
	if err != nil {
		if err == conf.ErrHelpWanted {
			fmt.Println(help)
			return nil
		}
		return fmt.Errorf("parsing config: %w", err)
	}

	log, err := logger.New("indexer", "info")
	if err != nil {
		return fmt.Errorf("constructing logger: %w", err)
	}
	defer log.Sync()

	log.Infow("starting indexer", "package_id", cfg.SUI.PackageID)

	db, err := database.Open(database.Config{
		User:       cfg.DB.User,
		Password:   cfg.DB.Password,
		Host:       cfg.DB.Host,
		Name:       cfg.DB.Name,
		DisableTLS: cfg.DB.DisableTLS,
	})
	if err != nil {
		return fmt.Errorf("connecting to db: %w", err)
	}
	defer db.Close()

	suiClient := sui.NewClient(cfg.SUI.RPCURL)
	userCore := user.NewCore(userdb.NewStore(db))
	acctCore := accounting.NewCore(ledgerdb.NewStore(db), userCore)

	// Load cursor from indexer_state.
	cursor, err := loadCursor(db, cfg.Indexer.Chain)
	if err != nil {
		return fmt.Errorf("loading cursor: %w", err)
	}

	log.Infow("loaded cursor", "cursor", cursor)

	// Shutdown handling.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(cfg.Indexer.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-shutdown:
			log.Infow("shutting down indexer")
			return nil
		case <-ticker.C:
			newCursor, err := pollEvents(ctx, log, suiClient, acctCore, userCore, db,
				cfg.SUI.PackageID, cfg.Indexer.Chain, cursor, cfg.Indexer.BatchSize)
			if err != nil {
				log.Errorw("poll error", "error", err)
				continue
			}
			if newCursor != nil {
				cursor = newCursor
			}
		}
	}
}

// DepositEvent is the parsed JSON from a SUI deposit event.
type DepositEvent struct {
	SUIAddress string `json:"sui_address"`
	Amount     string `json:"amount"`
	Currency   string `json:"currency"`
}

func pollEvents(
	ctx context.Context,
	log *zap.SugaredLogger,
	suiClient *sui.Client,
	acctCore *accounting.Core,
	userCore *user.Core,
	db *sqlx.DB,
	packageID, chain string,
	cursor *string,
	batchSize int,
) (*string, error) {
	page, err := suiClient.QueryEvents(ctx, packageID, cursor, batchSize)
	if err != nil {
		return cursor, fmt.Errorf("query events: %w", err)
	}

	if len(page.Data) == 0 {
		return cursor, nil
	}

	for _, evt := range page.Data {
		var deposit DepositEvent
		if err := json.Unmarshal(evt.ParsedJSON, &deposit); err != nil {
			log.Errorw("unmarshal event", "error", err, "tx", evt.ID.TxDigest)
			continue
		}

		amount, err := decimal.NewFromString(deposit.Amount)
		if err != nil {
			log.Errorw("parse amount", "error", err, "raw", deposit.Amount)
			continue
		}

		// Find or create user by SUI address.
		usr, err := userCore.FindOrCreate(ctx, user.NewUser{
			SUIAddress: deposit.SUIAddress,
		})
		if err != nil {
			log.Errorw("find/create user", "error", err, "address", deposit.SUIAddress)
			continue
		}

		referenceID := evt.ID.TxDigest + "-" + evt.ID.EventSeq
		currency := deposit.Currency
		if currency == "" {
			currency = accounting.CurrencyUSDC
		}

		if err := acctCore.ProcessDeposit(ctx, usr.ID, amount, currency, referenceID); err != nil {
			log.Errorw("process deposit", "error", err, "tx", evt.ID.TxDigest)
			continue
		}

		log.Infow("processed deposit",
			"user_id", usr.ID,
			"amount", amount.String(),
			"currency", currency,
			"tx", evt.ID.TxDigest,
		)
	}

	// Persist new cursor.
	if page.NextCursor != nil {
		if err := saveCursor(db, chain, *page.NextCursor); err != nil {
			return cursor, fmt.Errorf("saving cursor: %w", err)
		}
		return page.NextCursor, nil
	}

	return cursor, nil
}

func loadCursor(db *sqlx.DB, chain string) (*string, error) {
	var cursor string
	err := db.Get(&cursor, `SELECT last_cursor FROM indexer_state WHERE chain = $1`, chain)
	if err != nil {
		// No cursor yet — start from beginning.
		return nil, nil
	}
	if cursor == "" {
		return nil, nil
	}
	return &cursor, nil
}

func saveCursor(db *sqlx.DB, chain, cursor string) error {
	const q = `
		INSERT INTO indexer_state (chain, last_cursor, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (chain) DO UPDATE SET last_cursor = $2, updated_at = NOW()`

	if _, err := db.Exec(q, chain, cursor); err != nil {
		return fmt.Errorf("upsert cursor: %w", err)
	}
	return nil
}

