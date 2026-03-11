// Deposit indexer: polls Base chain for USDC Transfer events to known deposit addresses.
package main

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ardanlabs/conf/v3"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/jmoiron/sqlx"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	ledgerdb "github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/deposit"
	depositdb "github.com/flamefalcon/coin-pusher/backend/business/core/deposit/stores/depositdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
	"github.com/flamefalcon/coin-pusher/backend/foundation/logger"
	"github.com/flamefalcon/coin-pusher/backend/foundation/wallet"
)

type config struct {
	DB struct {
		User         string `conf:"default:postgres"`
		Password     string `conf:"default:postgres,mask"`
		Host         string `conf:"default:localhost:5432"`
		Name         string `conf:"default:coinpusher"`
		MaxIdleConns int    `conf:"default:2"`
		MaxOpenConns int    `conf:"default:5"`
		DisableTLS   bool   `conf:"default:false"`
	}
	Wallet struct {
		Seed string `conf:"mask"`
	}
	Indexer struct {
		RPCURL             string        `conf:"default:https://mainnet.base.org"`
		USDCContract       string        `conf:"default:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`
		PollInterval       time.Duration `conf:"default:10s"`
		StartBlock         int64         `conf:"default:0"`
		BlockRange         int64         `conf:"default:1000"`
		ConfirmationBlocks int64         `conf:"default:50"`
	}
}

// ERC-20 Transfer event topic: keccak256("Transfer(address,address,uint256)")
var transferTopic = common.HexToHash("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

// USDC uses 6 decimals.
var usdcDecimals = decimal.NewFromInt(1_000_000)

var (
	indexerBlockLag = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_indexer_block_lag",
		Help: "Number of blocks behind the chain tip.",
	})
	indexerBlockCursor = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_indexer_block_cursor",
		Help: "Current block cursor position.",
	})
	indexerDepositsProcessed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_indexer_deposits_processed_total",
		Help: "Total deposits successfully processed.",
	})
	indexerPollErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_indexer_poll_errors_total",
		Help: "Total poll errors.",
	})
	indexerRPCLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "coinpusher_indexer_rpc_latency_seconds",
		Help:    "RPC call latency.",
		Buckets: prometheus.DefBuckets,
	})
	indexerBlocksProcessed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_indexer_blocks_processed_total",
		Help: "Total blocks successfully scanned by indexer.",
	})
	indexerDepositErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_indexer_deposit_errors_total",
		Help: "Deposits that failed to process (balance not credited).",
	})
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	// -------------------------------------------------------------------------
	// Configuration
	var cfg config
	help, err := conf.Parse("BACKEND", &cfg)
	if err != nil {
		if err == conf.ErrHelpWanted {
			fmt.Println(help)
			return nil
		}
		return fmt.Errorf("parsing config: %w", err)
	}

	// -------------------------------------------------------------------------
	// Logger
	log, err := logger.New("indexer", "info")
	if err != nil {
		return fmt.Errorf("constructing logger: %w", err)
	}
	defer log.Sync()

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		log.Infow("indexer metrics server starting", "host", ":9091")
		if err := http.ListenAndServe(":9091", mux); err != nil {
			log.Errorw("indexer metrics server error", "error", err)
		}
	}()

	if cfg.Wallet.Seed == "" {
		return fmt.Errorf("BACKEND_WALLET_SEED is required")
	}

	// -------------------------------------------------------------------------
	// Database
	db, err := database.Open(database.Config{
		User:         cfg.DB.User,
		Password:     cfg.DB.Password,
		Host:         cfg.DB.Host,
		Name:         cfg.DB.Name,
		MaxIdleConns: cfg.DB.MaxIdleConns,
		MaxOpenConns: cfg.DB.MaxOpenConns,
		DisableTLS:   cfg.DB.DisableTLS,
	})
	if err != nil {
		return fmt.Errorf("connecting to db: %w", err)
	}
	defer db.Close()

	// -------------------------------------------------------------------------
	// Wallet
	w, err := wallet.New(cfg.Wallet.Seed)
	if err != nil {
		return fmt.Errorf("constructing wallet: %w", err)
	}

	// -------------------------------------------------------------------------
	// Business Core
	userCore := user.NewCore(userdb.NewStore(db))
	acctCore := accounting.NewCore(
		db,
		ledgerdb.NewStore(db),
		userCore,
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
	)
	depositCore := deposit.NewCore(
		db,
		depositdb.NewStore(db),
		w,
		acctCore,
		userCore,
		func(dbtx database.DBTX) deposit.Storer { return depositdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
	)

	// -------------------------------------------------------------------------
	// Ethereum Client
	client, err := ethclient.Dial(cfg.Indexer.RPCURL)
	if err != nil {
		return fmt.Errorf("connecting to rpc: %w", err)
	}
	defer client.Close()

	log.Infow("indexer starting",
		"rpc", cfg.Indexer.RPCURL,
		"usdc", cfg.Indexer.USDCContract,
		"poll_interval", cfg.Indexer.PollInterval,
	)

	// -------------------------------------------------------------------------
	// Determine starting block
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var lastBlock int64
	if cfg.Indexer.StartBlock > 0 {
		lastBlock = cfg.Indexer.StartBlock - 1
	} else {
		// Load from indexer_state table.
		var cursor string
		err := db.QueryRowContext(ctx, `SELECT last_cursor FROM indexer_state WHERE chain = 'base'`).Scan(&cursor)
		if err == nil && cursor != "" {
			n := new(big.Int)
			if _, ok := n.SetString(cursor, 10); ok {
				lastBlock = n.Int64()
			}
		}

		if lastBlock == 0 {
			// Use current block.
			header, err := client.HeaderByNumber(ctx, nil)
			if err != nil {
				return fmt.Errorf("getting latest block: %w", err)
			}
			lastBlock = header.Number.Int64()
			log.Infow("starting from latest block", "block", lastBlock)
		}
	}

	usdcAddr := common.HexToAddress(cfg.Indexer.USDCContract)

	// -------------------------------------------------------------------------
	// Poll loop
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(cfg.Indexer.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-shutdown:
			log.Infow("indexer shutting down")
			return nil
		case <-ticker.C:
			if err := pollOnce(ctx, log, client, depositCore, usdcAddr, &lastBlock, cfg.Indexer.BlockRange, cfg.Indexer.ConfirmationBlocks, db); err != nil {
				log.Errorw("poll error", "error", err)
				indexerPollErrors.Inc()
			}
		}
	}
}

func pollOnce(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	usdcAddr common.Address,
	lastBlock *int64,
	blockRange int64,
	confirmationBlocks int64,
	db *sqlx.DB,
) error {
	// Get the latest block number.
	rpcStart := time.Now()
	header, err := client.HeaderByNumber(ctx, nil)
	indexerRPCLatency.Observe(time.Since(rpcStart).Seconds())
	if err != nil {
		return fmt.Errorf("getting latest block: %w", err)
	}
	// P1-12: Only process blocks with sufficient confirmations to avoid reorgs.
	latestBlock := header.Number.Int64() - confirmationBlocks

	// Always update lag so Grafana shows it even when polls fail.
	indexerBlockLag.Set(float64(latestBlock - *lastBlock))

	if *lastBlock >= latestBlock {
		return nil
	}

	fromBlock := *lastBlock + 1
	toBlock := fromBlock + blockRange - 1
	if toBlock > latestBlock {
		toBlock = latestBlock
	}

	// Load all known deposit addresses.
	addrs, err := depositCore.QueryAllAddresses(ctx, deposit.DefaultChain)
	if err != nil {
		return fmt.Errorf("query all addresses: %w", err)
	}

	if len(addrs) == 0 {
		*lastBlock = toBlock
		return nil
	}

	// Build address lookup map (lowercased).
	addrMap := make(map[string]deposit.DepositAddress, len(addrs))
	for _, a := range addrs {
		addrMap[strings.ToLower(a.Address)] = a
	}

	// Filter logs for ERC-20 Transfer events to known addresses.
	query := ethereum.FilterQuery{
		FromBlock: big.NewInt(fromBlock),
		ToBlock:   big.NewInt(toBlock),
		Addresses: []common.Address{usdcAddr},
		Topics:    [][]common.Hash{{transferTopic}},
	}

	evtLogs, err := client.FilterLogs(ctx, query)
	if err != nil {
		return fmt.Errorf("filter logs: %w", err)
	}

	for _, vLog := range evtLogs {
		if len(vLog.Topics) < 3 {
			continue
		}

		// ERC-20 Transfer: topics[1]=from, topics[2]=to
		toAddr := common.HexToAddress(vLog.Topics[2].Hex())
		toAddrLower := strings.ToLower(toAddr.Hex())

		depAddr, ok := addrMap[toAddrLower]
		if !ok {
			continue
		}

		// Parse amount (USDC has 6 decimals).
		rawAmount := new(big.Int).SetBytes(vLog.Data)
		amount := decimal.NewFromBigInt(rawAmount, 0).Div(usdcDecimals)

		// Skip dust deposits.
		if amount.LessThan(deposit.MinDeposit) {
			log.Infow("skipping dust deposit",
				"tx_hash", vLog.TxHash.Hex(),
				"amount", amount,
				"min", deposit.MinDeposit,
			)
			continue
		}

		fromAddr := common.HexToAddress(vLog.Topics[1].Hex())
		txHash := vLog.TxHash.Hex()
		blockNum := int64(vLog.BlockNumber)

		log.Infow("processing deposit",
			"tx_hash", txHash,
			"account_id", depAddr.AccountID,
			"amount", amount,
			"from", fromAddr.Hex(),
			"block", blockNum,
		)

		if err := depositCore.ProcessDeposit(ctx, depAddr.AccountID, amount, txHash, blockNum, fromAddr.Hex()); err != nil {
			// P1-17: Do NOT advance cursor past failed deposits.
			// Return error so the block range is retried next poll.
			indexerDepositErrors.Inc()
			return fmt.Errorf("process deposit tx %s: %w", txHash, err)
		}
		indexerDepositsProcessed.Inc()
	}

	// Update cursor — only reached when ALL deposits in range succeeded.
	indexerBlocksProcessed.Add(float64(toBlock - fromBlock + 1))
	*lastBlock = toBlock
	saveBlockCursor(ctx, db, toBlock)
	indexerBlockCursor.Set(float64(toBlock))
	indexerBlockLag.Set(float64(latestBlock - toBlock))

	return nil
}

func saveBlockCursor(ctx context.Context, db *sqlx.DB, blockNumber int64) {
	const q = `
		INSERT INTO indexer_state (chain, last_cursor, updated_at)
		VALUES ('base', $1, NOW())
		ON CONFLICT (chain) DO UPDATE SET last_cursor = $1, updated_at = NOW()`

	if _, err := db.ExecContext(ctx, q, fmt.Sprintf("%d", blockNumber)); err != nil {
		// Log but don't fail — cursor will be re-read on restart.
		fmt.Fprintf(os.Stderr, "saving block cursor: %v\n", err)
	}
}
