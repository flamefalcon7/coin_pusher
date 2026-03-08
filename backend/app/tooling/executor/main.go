// Executor: processes approved withdrawals and sweeps deposit addresses.
package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ardanlabs/conf/v3"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/google/uuid"
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
	ethutil "github.com/flamefalcon/coin-pusher/backend/foundation/ethereum"
	"github.com/flamefalcon/coin-pusher/backend/foundation/logger"
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
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
	Executor struct {
		RPCURL         string        `conf:"default:https://mainnet.base.org"`
		USDCContract   string        `conf:"default:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`
		HotWalletIndex int           `conf:"default:999999"`
		PollInterval   time.Duration `conf:"default:15s"`
		BatchSize      int           `conf:"default:5"`
		ReceiptTimeout time.Duration `conf:"default:120s"`
		SweepThreshold float64       `conf:"default:10"`
		SweepInterval  time.Duration `conf:"default:30m"`
		GasFundAmount  float64       `conf:"default:0.0001"`
		MaxGasPrice    float64       `conf:"default:5"` // gwei — skip execution when base fee exceeds this
	}
}

// Base chain ID.
var baseChainID = big.NewInt(8453)

// advisoryKeyExecutor is the PostgreSQL advisory lock key used to ensure
// only one executor instance runs at a time.
const advisoryKeyExecutor int64 = 0x65786563_75746F72 // "executor"

var (
	executorWithdrawalsProcessed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_executor_withdrawals_processed_total",
		Help: "Total withdrawals successfully processed.",
	})
	executorWithdrawalsFailed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_executor_withdrawals_failed_total",
		Help: "Total failed withdrawals.",
	})
	executorSweepsTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_executor_sweeps_total",
		Help: "Total sweep operations.",
	})
	executorGasPrice = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_executor_gas_price_gwei",
		Help: "Current base fee in gwei.",
	})
	executorRPCLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "coinpusher_executor_rpc_latency_seconds",
		Help:    "RPC call latency.",
		Buckets: prometheus.DefBuckets,
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
	log, err := logger.New("executor", "info")
	if err != nil {
		return fmt.Errorf("constructing logger: %w", err)
	}
	defer log.Sync()

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		log.Infow("executor metrics server starting", "host", ":9092")
		if err := http.ListenAndServe(":9092", mux); err != nil {
			log.Errorw("executor metrics server error", "error", err)
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
	// Single-instance enforcement via session-level advisory lock.
	var locked bool
	if err := db.QueryRow("SELECT pg_try_advisory_lock($1)", advisoryKeyExecutor).Scan(&locked); err != nil {
		return fmt.Errorf("acquiring executor advisory lock: %w", err)
	}
	if !locked {
		return fmt.Errorf("another executor instance is already running (advisory lock held)")
	}
	log.Infow("acquired executor advisory lock — single instance confirmed")

	// -------------------------------------------------------------------------
	// Wallet
	w, err := wallet.New(cfg.Wallet.Seed)
	if err != nil {
		return fmt.Errorf("constructing wallet: %w", err)
	}

	// Derive hot wallet key.
	hotKey, err := w.DerivePrivateKey(cfg.Executor.HotWalletIndex)
	if err != nil {
		return fmt.Errorf("deriving hot wallet key: %w", err)
	}
	hotAddr, err := w.DeriveAddress(cfg.Executor.HotWalletIndex)
	if err != nil {
		return fmt.Errorf("deriving hot wallet address: %w", err)
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
	client, err := ethclient.Dial(cfg.Executor.RPCURL)
	if err != nil {
		return fmt.Errorf("connecting to rpc: %w", err)
	}
	defer client.Close()

	usdcAddr := common.HexToAddress(cfg.Executor.USDCContract)
	sweepThreshold := decimal.NewFromFloat(cfg.Executor.SweepThreshold)
	gasFundWei := ethToWei(cfg.Executor.GasFundAmount)
	maxGasPriceWei := gweiToWei(cfg.Executor.MaxGasPrice)

	log.Infow("executor starting",
		"rpc", cfg.Executor.RPCURL,
		"hot_wallet", hotAddr,
		"usdc_contract", cfg.Executor.USDCContract,
		"poll_interval", cfg.Executor.PollInterval,
		"sweep_interval", cfg.Executor.SweepInterval,
		"sweep_threshold", cfg.Executor.SweepThreshold,
		"batch_size", cfg.Executor.BatchSize,
	)

	// -------------------------------------------------------------------------
	// Recovery: resolve any orphaned 'submitted' withdrawals from a previous crash.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := recoverSubmittedWithdrawals(ctx, log, client, depositCore, cfg.Executor.ReceiptTimeout); err != nil {
		log.Errorw("withdrawal recovery error (non-fatal)", "error", err)
	}

	if err := recoverStuckSweeps(ctx, log, client, depositCore, cfg.Executor.ReceiptTimeout); err != nil {
		log.Errorw("sweep recovery error (non-fatal)", "error", err)
	}

	// -------------------------------------------------------------------------
	// Main loop
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	withdrawTicker := time.NewTicker(cfg.Executor.PollInterval)
	defer withdrawTicker.Stop()

	sweepTicker := time.NewTicker(cfg.Executor.SweepInterval)
	defer sweepTicker.Stop()

	for {
		select {
		case <-shutdown:
			log.Infow("executor shutting down")
			return nil

		case <-withdrawTicker.C:
			if gasTooExpensive(ctx, log, client, maxGasPriceWei) {
				continue
			}
			if err := processWithdrawals(ctx, log, client, depositCore, hotKey, hotAddr, usdcAddr, cfg.Executor.BatchSize, cfg.Executor.ReceiptTimeout); err != nil {
				log.Errorw("withdraw loop error", "error", err)
			}

		case <-sweepTicker.C:
			if gasTooExpensive(ctx, log, client, maxGasPriceWei) {
				continue
			}
			if err := processSweeps(ctx, log, client, depositCore, w, hotKey, hotAddr, usdcAddr, sweepThreshold, gasFundWei); err != nil {
				log.Errorw("sweep loop error", "error", err)
			}
		}
	}
}

// =========================================================================
// Recovery
// =========================================================================

// recoverSubmittedWithdrawals resolves withdrawals that were marked 'submitted'
// but never confirmed/failed (e.g., due to a crash after broadcast).
func recoverSubmittedWithdrawals(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	receiptTimeout time.Duration,
) error {
	submitted, err := depositCore.QuerySubmittedWithdrawals(ctx, 100)
	if err != nil {
		return fmt.Errorf("query submitted withdrawals: %w", err)
	}

	if len(submitted) == 0 {
		return nil
	}

	log.Infow("recovering orphaned submitted withdrawals", "count", len(submitted))

	for _, wr := range submitted {
		if wr.TxHash == nil || *wr.TxHash == "" {
			// No tx_hash recorded — the tx was never broadcast. Refund.
			log.Infow("refunding submitted withdrawal without tx_hash",
				"request_id", wr.RequestID,
			)
			if err := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, "no tx_hash recorded — likely crashed before broadcast"); err != nil {
				metrics.WithdrawalRefundErrors.Inc()
				log.Errorw("recovery refund failed", "request_id", wr.RequestID, "error", err)
			}
			continue
		}

		// Has tx_hash — poll for receipt.
		txHash := common.HexToHash(*wr.TxHash)
		receipt, err := waitForReceipt(ctx, client, txHash, receiptTimeout)
		if err != nil {
			// Receipt timeout — can't determine on-chain status.
			// Log error but do NOT refund (tx might still be in mempool).
			log.Errorw("recovery: receipt timeout for submitted withdrawal — manual review needed",
				"request_id", wr.RequestID,
				"tx_hash", *wr.TxHash,
				"error", err,
			)
			continue
		}

		if receipt.Status == types.ReceiptStatusSuccessful {
			hashStr := *wr.TxHash
			if err := depositCore.UpdateWithdrawStatus(ctx, wr.RequestID, "confirmed", &hashStr, nil); err != nil {
				log.Errorw("recovery confirm failed", "request_id", wr.RequestID, "error", err)
			} else {
				log.Infow("recovery: confirmed submitted withdrawal", "request_id", wr.RequestID, "tx_hash", *wr.TxHash)
			}
		} else {
			if err := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, "on-chain tx reverted (recovered)"); err != nil {
				metrics.WithdrawalRefundErrors.Inc()
				log.Errorw("recovery refund failed", "request_id", wr.RequestID, "error", err)
			} else {
				log.Infow("recovery: refunded reverted withdrawal", "request_id", wr.RequestID, "tx_hash", *wr.TxHash)
			}
		}
	}

	return nil
}

// recoverStuckSweeps resolves sweeps stuck in non-terminal statuses
// (pending, gas_funded, submitted) from a previous crash.
func recoverStuckSweeps(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	receiptTimeout time.Duration,
) error {
	sweeps, err := depositCore.QueryRecoverableSweeps(ctx, 100)
	if err != nil {
		return fmt.Errorf("query recoverable sweeps: %w", err)
	}

	if len(sweeps) == 0 {
		return nil
	}

	log.Infow("recovering stuck sweeps", "count", len(sweeps))

	for _, sw := range sweeps {
		switch sw.Status {
		case "pending":
			// Check if gas fund tx was broadcast (has gas_fund_tx_hash).
			if sw.GasFundTxHash != nil && *sw.GasFundTxHash != "" {
				gasTxHash := common.HexToHash(*sw.GasFundTxHash)
				receipt, err := waitForReceipt(ctx, client, gasTxHash, receiptTimeout)
				if err != nil {
					// Gas fund tx status unknown — mark failed so a fresh sweep can retry.
					log.Errorw("sweep recovery: gas fund receipt timeout — marking failed for retry",
						"sweep_id", sw.SweepID,
						"gas_tx_hash", *sw.GasFundTxHash,
					)
					errMsg := "gas fund receipt timeout on recovery — marked failed for retry"
					depositCore.UpdateSweepStatus(ctx, sw.SweepID, "failed", nil, nil, &errMsg)
					continue
				}
				if receipt.Status == types.ReceiptStatusSuccessful {
					// Gas was funded — advance to gas_funded so next sweep cycle can resume.
					log.Infow("sweep recovery: gas fund confirmed, advancing to gas_funded", "sweep_id", sw.SweepID)
					depositCore.UpdateSweepStatus(ctx, sw.SweepID, "gas_funded", nil, sw.GasFundTxHash, nil)
				} else {
					errMsg := "gas fund tx reverted on-chain (recovered)"
					depositCore.UpdateSweepStatus(ctx, sw.SweepID, "failed", nil, nil, &errMsg)
				}
			} else {
				// No gas fund tx — this sweep never progressed. Mark failed for retry.
				errMsg := "stuck in pending with no gas fund tx — marked failed for retry"
				depositCore.UpdateSweepStatus(ctx, sw.SweepID, "failed", nil, nil, &errMsg)
			}

		case "gas_funded":
			// Gas was funded but sweep tx was never signed/broadcast.
			// Mark failed so a new sweep can be created on the next cycle.
			log.Infow("sweep recovery: stuck in gas_funded — marking failed for retry", "sweep_id", sw.SweepID)
			errMsg := "stuck in gas_funded — likely crashed before sweep tx broadcast"
			depositCore.UpdateSweepStatus(ctx, sw.SweepID, "failed", nil, nil, &errMsg)

		case "submitted":
			// Sweep tx was broadcast but never confirmed.
			if sw.SweepTxHash == nil || *sw.SweepTxHash == "" {
				errMsg := "no sweep_tx_hash recorded — likely crashed before broadcast"
				depositCore.UpdateSweepStatus(ctx, sw.SweepID, "failed", nil, nil, &errMsg)
				continue
			}

			txHash := common.HexToHash(*sw.SweepTxHash)
			receipt, err := waitForReceipt(ctx, client, txHash, receiptTimeout)
			if err != nil {
				log.Errorw("sweep recovery: receipt timeout — manual review needed",
					"sweep_id", sw.SweepID,
					"tx_hash", *sw.SweepTxHash,
				)
				continue
			}

			if receipt.Status == types.ReceiptStatusSuccessful {
				hashStr := *sw.SweepTxHash
				if err := depositCore.UpdateSweepStatus(ctx, sw.SweepID, "confirmed", &hashStr, nil, nil); err != nil {
					log.Errorw("sweep recovery: confirm failed", "sweep_id", sw.SweepID, "error", err)
				} else {
					log.Infow("sweep recovery: confirmed", "sweep_id", sw.SweepID, "tx_hash", *sw.SweepTxHash)
				}
			} else {
				errMsg := "sweep tx reverted on-chain (recovered)"
				if err := depositCore.UpdateSweepStatus(ctx, sw.SweepID, "failed", nil, nil, &errMsg); err != nil {
					log.Errorw("sweep recovery: mark failed error", "sweep_id", sw.SweepID, "error", err)
				} else {
					log.Infow("sweep recovery: marked failed (reverted)", "sweep_id", sw.SweepID, "tx_hash", *sw.SweepTxHash)
				}
			}
		}
	}

	return nil
}

// =========================================================================
// Withdraw Loop
// =========================================================================

func processWithdrawals(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	hotKey *ecdsa.PrivateKey,
	hotAddr string,
	usdcAddr common.Address,
	batchSize int,
	receiptTimeout time.Duration,
) error {
	// Atomically claim approved withdrawals (status → submitted).
	// FOR UPDATE SKIP LOCKED prevents concurrent instances from double-claiming.
	requests, err := depositCore.ClaimApprovedWithdrawals(ctx, batchSize)
	if err != nil {
		return fmt.Errorf("claim approved: %w", err)
	}

	if len(requests) == 0 {
		return nil
	}

	log.Infow("processing withdrawals", "count", len(requests))

	hotAddress := common.HexToAddress(hotAddr)

	// Fetch the initial nonce once, then increment locally for the batch
	// to avoid stale-nonce issues when RPC hasn't propagated yet.
	nonce, err := client.PendingNonceAt(ctx, hotAddress)
	if err != nil {
		return fmt.Errorf("getting initial nonce: %w", err)
	}

	for _, wr := range requests {
		broadcasted, err := executeWithdrawal(ctx, log, client, depositCore, hotKey, hotAddress, usdcAddr, wr, receiptTimeout, nonce)
		if err != nil {
			log.Errorw("withdrawal failed",
				"request_id", wr.RequestID,
				"error", err,
			)
		}
		// Only increment nonce if the tx was actually broadcast (or signed with
		// this nonce). If it failed before broadcast, the nonce is still available.
		if broadcasted {
			nonce++
		}
	}

	return nil
}

// executeWithdrawal processes a single withdrawal. Returns (broadcasted, error).
// broadcasted indicates whether the nonce was consumed (tx was signed and
// broadcast attempted), so the caller knows whether to increment the local nonce.
func executeWithdrawal(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	hotKey *ecdsa.PrivateKey,
	hotAddress common.Address,
	usdcAddr common.Address,
	wr deposit.WithdrawRequest,
	receiptTimeout time.Duration,
	nonce uint64,
) (broadcasted bool, err error) {
	// Encode ERC-20 transfer(to, amount_usdc * 1e6).
	toAddr := common.HexToAddress(wr.ToAddress)
	rawAmount := wr.AmountUSDC.Mul(decimal.NewFromInt(1_000_000)).BigInt()
	calldata := ethutil.EncodeTransfer(toAddr, rawAmount)

	// Estimate gas. Failure here means the tx would revert — safe to refund
	// since no nonce has been consumed.
	gasLimit, err := client.EstimateGas(ctx, ethereum.CallMsg{
		From: hotAddress,
		To:   &usdcAddr,
		Data: calldata,
	})
	if err != nil {
		errMsg := fmt.Sprintf("gas estimate failed: %v", err)
		if refundErr := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, errMsg); refundErr != nil {
			metrics.WithdrawalRefundErrors.Inc()
			return false, refundErr
		}
		return false, nil
	}

	// EIP-1559 fee parameters. Failure here is transient — safe to refund (no nonce consumed).
	gasTipCap, err := client.SuggestGasTipCap(ctx)
	if err != nil {
		errMsg := fmt.Sprintf("getting gas tip cap: %v", err)
		if refundErr := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, errMsg); refundErr != nil {
			metrics.WithdrawalRefundErrors.Inc()
			return false, refundErr
		}
		return false, nil
	}

	head, err := client.HeaderByNumber(ctx, nil)
	if err != nil {
		errMsg := fmt.Sprintf("getting latest header: %v", err)
		if refundErr := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, errMsg); refundErr != nil {
			metrics.WithdrawalRefundErrors.Inc()
			return false, refundErr
		}
		return false, nil
	}
	gasFeeCap := new(big.Int).Add(
		new(big.Int).Mul(head.BaseFee, big.NewInt(2)),
		gasTipCap,
	)

	// Build and sign EIP-1559 transaction.
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   baseChainID,
		Nonce:     nonce,
		GasTipCap: gasTipCap,
		GasFeeCap: gasFeeCap,
		Gas:       gasLimit,
		To:        &usdcAddr,
		Value:     big.NewInt(0),
		Data:      calldata,
	})
	signer := types.LatestSignerForChainID(baseChainID)
	signedTx, err := types.SignTx(tx, signer, hotKey)
	if err != nil {
		// Signing failed — nonce not consumed (tx never created). Safe to refund.
		errMsg := fmt.Sprintf("sign tx failed: %v", err)
		if refundErr := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, errMsg); refundErr != nil {
			metrics.WithdrawalRefundErrors.Inc()
			return false, refundErr
		}
		return false, nil
	}

	// Save tx_hash BEFORE broadcasting so recovery can find it after a crash.
	txHash := signedTx.Hash().Hex()
	if err := depositCore.UpdateWithdrawStatus(ctx, wr.RequestID, "submitted", &txHash, nil); err != nil {
		// DB write failed — tx was never broadcast, safe to refund immediately.
		refundErr := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, fmt.Sprintf("save tx_hash failed: %v", err))
		if refundErr != nil {
			// Both failed — recovery loop will handle on next restart.
			metrics.WithdrawalRefundErrors.Inc()
			return false, fmt.Errorf("save tx_hash failed: %v; refund also failed: %w", err, refundErr)
		}
		return false, fmt.Errorf("save tx_hash before broadcast: %w", err)
	}

	// Broadcast transaction.
	// After this point the nonce is consumed regardless of the RPC response,
	// because the tx may have been propagated even if the call returns an error.
	if err := client.SendTransaction(ctx, signedTx); err != nil {
		// DO NOT refund here — the tx might have been propagated despite the error.
		// tx_hash is already saved; recovery loop will resolve it on next startup.
		log.Errorw("broadcast returned error — tx may still confirm, leaving as submitted for recovery",
			"request_id", wr.RequestID,
			"tx_hash", txHash,
			"error", err,
		)
		return true, fmt.Errorf("broadcast error (recovery will handle): %w", err)
	}

	log.Infow("withdrawal tx broadcast",
		"request_id", wr.RequestID,
		"tx_hash", txHash,
		"to", wr.ToAddress,
		"amount_usdc", wr.AmountUSDC,
	)

	// Wait for receipt.
	receipt, err := waitForReceipt(ctx, client, signedTx.Hash(), receiptTimeout)
	if err != nil {
		// Don't refund on timeout — the tx might still confirm.
		// Recovery loop will handle it on next startup.
		log.Errorw("receipt timeout — will be resolved by recovery loop",
			"request_id", wr.RequestID,
			"tx_hash", txHash,
		)
		return true, fmt.Errorf("receipt timeout: %w", err)
	}

	if receipt.Status == types.ReceiptStatusFailed {
		errMsg := "on-chain tx reverted"
		executorWithdrawalsFailed.Inc()
		if refundErr := depositCore.RefundFailedWithdrawal(ctx, wr.RequestID, errMsg); refundErr != nil {
			metrics.WithdrawalRefundErrors.Inc()
			return true, refundErr
		}
		return true, nil
	}

	// Success — confirmed.
	if err := depositCore.UpdateWithdrawStatus(ctx, wr.RequestID, "confirmed", &txHash, nil); err != nil {
		return true, fmt.Errorf("update status to confirmed: %w", err)
	}
	executorWithdrawalsProcessed.Inc()

	log.Infow("withdrawal confirmed",
		"request_id", wr.RequestID,
		"tx_hash", txHash,
	)

	return true, nil
}

// =========================================================================
// Sweep Loop
// =========================================================================

func processSweeps(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	w *wallet.Wallet,
	hotKey *ecdsa.PrivateKey,
	hotAddr string,
	usdcAddr common.Address,
	sweepThreshold decimal.Decimal,
	gasFundWei *big.Int,
) error {
	addrs, err := depositCore.QueryAllAddresses(ctx, deposit.DefaultChain)
	if err != nil {
		return fmt.Errorf("query deposit addresses: %w", err)
	}

	if len(addrs) == 0 {
		return nil
	}

	hotAddress := common.HexToAddress(hotAddr)
	thresholdRaw := sweepThreshold.Mul(decimal.NewFromInt(1_000_000)).BigInt()

	for _, depAddr := range addrs {
		// P1-3: Skip addresses with active sweeps in progress.
		active, err := depositCore.HasActiveSweep(ctx, depAddr.AddressID)
		if err != nil {
			log.Errorw("checking active sweep failed", "address", depAddr.Address, "error", err)
			continue
		}
		if active {
			continue
		}

		addr := common.HexToAddress(depAddr.Address)

		// Query on-chain USDC balance via balanceOf.
		balanceData := ethutil.EncodeBalanceOf(addr)
		result, err := client.CallContract(ctx, ethereum.CallMsg{
			To:   &usdcAddr,
			Data: balanceData,
		}, nil)
		if err != nil {
			log.Errorw("balanceOf call failed",
				"address", depAddr.Address,
				"error", err,
			)
			continue
		}

		balance := new(big.Int).SetBytes(result)
		if balance.Cmp(thresholdRaw) < 0 {
			continue
		}

		balanceDecimal := decimal.NewFromBigInt(balance, 0).Div(decimal.NewFromInt(1_000_000))

		log.Infow("sweeping deposit address",
			"address", depAddr.Address,
			"balance_usdc", balanceDecimal,
			"derivation_index", depAddr.DerivationIndex,
		)
		executorSweepsTotal.Inc()

		if err := executeSweep(ctx, log, client, depositCore, w, hotKey, depAddr, hotAddress, hotAddr, usdcAddr, balance, balanceDecimal, gasFundWei); err != nil {
			log.Errorw("sweep failed",
				"address", depAddr.Address,
				"error", err,
			)
		}
	}

	return nil
}

func executeSweep(
	ctx context.Context,
	log *zap.SugaredLogger,
	client *ethclient.Client,
	depositCore *deposit.Core,
	w *wallet.Wallet,
	hotKey *ecdsa.PrivateKey,
	depAddr deposit.DepositAddress,
	hotAddress common.Address,
	hotAddrStr string,
	usdcAddr common.Address,
	balance *big.Int,
	balanceDecimal decimal.Decimal,
	gasFundWei *big.Int,
) error {
	now := time.Now().UTC()
	sweepID := uuid.New()
	sweep := deposit.Sweep{
		SweepID:          sweepID,
		DepositAddressID: depAddr.AddressID,
		AccountID:        depAddr.AccountID,
		Chain:            deposit.DefaultChain,
		FromAddress:      depAddr.Address,
		ToAddress:        hotAddrStr,
		AmountUSDC:       balanceDecimal,
		Status:           "pending",
		CreatedAt:        now,
	}
	if err := depositCore.CreateSweep(ctx, sweep); err != nil {
		return fmt.Errorf("create sweep record: %w", err)
	}

	depositAddress := common.HexToAddress(depAddr.Address)

	// Check if deposit address has enough ETH for gas. If not, JIT fund it.
	ethBalance, err := client.BalanceAt(ctx, depositAddress, nil)
	if err != nil {
		return fmt.Errorf("checking eth balance: %w", err)
	}

	if ethBalance.Cmp(gasFundWei) < 0 {
		nonce, err := client.PendingNonceAt(ctx, hotAddress)
		if err != nil {
			return fmt.Errorf("getting hot wallet nonce for gas fund: %w", err)
		}

		gasTipCap, err := client.SuggestGasTipCap(ctx)
		if err != nil {
			return fmt.Errorf("getting gas tip cap: %w", err)
		}
		head, err := client.HeaderByNumber(ctx, nil)
		if err != nil {
			return fmt.Errorf("getting latest header: %w", err)
		}
		gasFeeCap := new(big.Int).Add(
			new(big.Int).Mul(head.BaseFee, big.NewInt(2)),
			gasTipCap,
		)

		gasTx := types.NewTx(&types.DynamicFeeTx{
			ChainID:   baseChainID,
			Nonce:     nonce,
			GasTipCap: gasTipCap,
			GasFeeCap: gasFeeCap,
			Gas:       21000,
			To:        &depositAddress,
			Value:     gasFundWei,
		})
		signer := types.LatestSignerForChainID(baseChainID)
		signedGasTx, err := types.SignTx(gasTx, signer, hotKey)
		if err != nil {
			errMsg := fmt.Sprintf("sign gas fund tx: %v", err)
			return depositCore.UpdateSweepStatus(ctx, sweepID, "failed", nil, nil, &errMsg)
		}

		gasTxHash := signedGasTx.Hash().Hex()

		// Save gas_fund_tx_hash before broadcast (write-ahead).
		if err := depositCore.UpdateSweepStatus(ctx, sweepID, "pending", nil, &gasTxHash, nil); err != nil {
			return fmt.Errorf("save gas fund tx_hash: %w", err)
		}

		if err := client.SendTransaction(ctx, signedGasTx); err != nil {
			// Don't mark as "failed" — the tx may have been propagated.
			log.Errorw("gas fund broadcast error — leaving sweep as pending for recovery",
				"sweep_id", sweepID,
				"gas_tx_hash", gasTxHash,
				"error", err,
			)
			return fmt.Errorf("gas fund broadcast error: %w", err)
		}

		log.Infow("gas funding sent", "tx_hash", gasTxHash, "to", depAddr.Address)

		receipt, err := waitForReceipt(ctx, client, signedGasTx.Hash(), 60*time.Second)
		if err != nil {
			// Receipt timeout — tx may still confirm. Leave as pending for retry.
			log.Errorw("gas fund receipt timeout — will retry on next sweep cycle",
				"sweep_id", sweepID,
				"gas_tx_hash", gasTxHash,
				"error", err,
			)
			return fmt.Errorf("gas fund receipt timeout: %w", err)
		}
		if receipt.Status != types.ReceiptStatusSuccessful {
			// On-chain revert is definitive — safe to mark failed.
			errMsg := "gas funding tx reverted on-chain"
			return depositCore.UpdateSweepStatus(ctx, sweepID, "failed", nil, &gasTxHash, &errMsg)
		}

		if err := depositCore.UpdateSweepStatus(ctx, sweepID, "gas_funded", nil, &gasTxHash, nil); err != nil {
			return fmt.Errorf("update sweep gas_funded: %w", err)
		}
	}

	// Sign ERC-20 transfer from deposit address → hot wallet using deposit key.
	depKey, err := w.DerivePrivateKey(depAddr.DerivationIndex)
	if err != nil {
		return fmt.Errorf("derive deposit key: %w", err)
	}

	calldata := ethutil.EncodeTransfer(hotAddress, balance)

	depNonce, err := client.PendingNonceAt(ctx, depositAddress)
	if err != nil {
		return fmt.Errorf("getting deposit address nonce: %w", err)
	}

	gasTipCap, err := client.SuggestGasTipCap(ctx)
	if err != nil {
		return fmt.Errorf("getting gas tip cap: %w", err)
	}
	head, err := client.HeaderByNumber(ctx, nil)
	if err != nil {
		return fmt.Errorf("getting latest header: %w", err)
	}
	gasFeeCap := new(big.Int).Add(
		new(big.Int).Mul(head.BaseFee, big.NewInt(2)),
		gasTipCap,
	)

	gasLimit, err := client.EstimateGas(ctx, ethereum.CallMsg{
		From: depositAddress,
		To:   &usdcAddr,
		Data: calldata,
	})
	if err != nil {
		errMsg := fmt.Sprintf("gas estimate for sweep: %v", err)
		return depositCore.UpdateSweepStatus(ctx, sweepID, "failed", nil, nil, &errMsg)
	}

	sweepTx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   baseChainID,
		Nonce:     depNonce,
		GasTipCap: gasTipCap,
		GasFeeCap: gasFeeCap,
		Gas:       gasLimit,
		To:        &usdcAddr,
		Value:     big.NewInt(0),
		Data:      calldata,
	})
	signer := types.LatestSignerForChainID(baseChainID)
	signedSweepTx, err := types.SignTx(sweepTx, signer, depKey)
	if err != nil {
		errMsg := fmt.Sprintf("sign sweep tx: %v", err)
		return depositCore.UpdateSweepStatus(ctx, sweepID, "failed", nil, nil, &errMsg)
	}

	sweepTxHash := signedSweepTx.Hash().Hex()

	if err := depositCore.UpdateSweepStatus(ctx, sweepID, "submitted", &sweepTxHash, nil, nil); err != nil {
		return fmt.Errorf("update sweep submitted: %w", err)
	}

	if err := client.SendTransaction(ctx, signedSweepTx); err != nil {
		// Don't mark as "failed" — the tx may have been propagated.
		// Leave as "submitted" for recovery/manual review.
		log.Errorw("sweep broadcast returned error — leaving as submitted for recovery",
			"sweep_id", sweepID,
			"tx_hash", sweepTxHash,
			"error", err,
		)
		return fmt.Errorf("sweep broadcast error: %w", err)
	}

	log.Infow("sweep tx broadcast",
		"tx_hash", sweepTxHash,
		"from", depAddr.Address,
		"amount_usdc", balanceDecimal,
	)

	receipt, err := waitForReceipt(ctx, client, signedSweepTx.Hash(), 120*time.Second)
	if err != nil {
		// Don't mark as "failed" — the tx might still confirm.
		// Leave as "submitted" so HasActiveSweep prevents duplicates
		// and a future recovery/manual process can resolve it.
		log.Errorw("sweep receipt timeout — leaving as submitted for recovery",
			"sweep_id", sweepID,
			"tx_hash", sweepTxHash,
			"error", err,
		)
		return fmt.Errorf("sweep receipt timeout: %w", err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		errMsg := "sweep tx reverted on-chain"
		return depositCore.UpdateSweepStatus(ctx, sweepID, "failed", &sweepTxHash, nil, &errMsg)
	}

	if err := depositCore.UpdateSweepStatus(ctx, sweepID, "confirmed", &sweepTxHash, nil, nil); err != nil {
		return fmt.Errorf("update sweep confirmed: %w", err)
	}

	log.Infow("sweep confirmed",
		"tx_hash", sweepTxHash,
		"from", depAddr.Address,
		"amount_usdc", balanceDecimal,
	)

	return nil
}

// =========================================================================
// Helpers
// =========================================================================

func waitForReceipt(ctx context.Context, client *ethclient.Client, txHash common.Hash, timeout time.Duration) (*types.Receipt, error) {
	deadline := time.Now().Add(timeout)
	for {
		receipt, err := client.TransactionReceipt(ctx, txHash)
		if err == nil {
			return receipt, nil
		}

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("receipt timeout after %s for tx %s", timeout, txHash.Hex())
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

// gasTooExpensive checks if the current base fee exceeds the configured max.
// Returns true (skip this tick) if gas is too expensive or if the check fails.
func gasTooExpensive(ctx context.Context, log *zap.SugaredLogger, client *ethclient.Client, maxGasPriceWei *big.Int) bool {
	rpcStart := time.Now()
	head, err := client.HeaderByNumber(ctx, nil)
	executorRPCLatency.Observe(time.Since(rpcStart).Seconds())
	if err != nil {
		log.Errorw("gas price check: failed to get header", "error", err)
		return true
	}
	executorGasPrice.Set(float64(head.BaseFee.Int64()) / 1e9)
	if head.BaseFee.Cmp(maxGasPriceWei) > 0 {
		log.Infow("gas too expensive — skipping this tick",
			"base_fee_gwei", new(big.Int).Div(head.BaseFee, big.NewInt(1_000_000_000)),
			"max_gwei", new(big.Int).Div(maxGasPriceWei, big.NewInt(1_000_000_000)),
		)
		return true
	}
	return false
}

func gweiToWei(gwei float64) *big.Int {
	gweiDec := decimal.NewFromFloat(gwei)
	weiDec := gweiDec.Mul(decimal.NewFromInt(1_000_000_000))
	return weiDec.BigInt()
}

func ethToWei(eth float64) *big.Int {
	weiPerEth := new(big.Int).SetUint64(1_000_000_000_000_000_000)
	ethDec := decimal.NewFromFloat(eth)
	weiDec := ethDec.Mul(decimal.NewFromBigInt(weiPerEth, 0))
	return weiDec.BigInt()
}
