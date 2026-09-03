// Package depositgrp provides HTTP handlers for deposit/withdrawal operations.
package depositgrp

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/deposit"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/ethereum"
)

// Group holds the handler dependencies.
type Group struct {
	deposit *deposit.Core
	user    *user.Core
}

// New constructs a handler Group.
func New(deposit *deposit.Core, user *user.Core) *Group {
	return &Group{deposit: deposit, user: user}
}

// =========================================================================
// GET /v1/deposit/address
// =========================================================================

type addressResponse struct {
	Address      string `json:"address"`
	Chain        string `json:"chain"`
	ChainID      int    `json:"chain_id"`
	USDCContract string `json:"usdc_contract"`
	MinDeposit   string `json:"min_deposit"`
}

// GetAddress returns the user's deposit address, creating one if needed.
func (g *Group) GetAddress(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	addr, err := g.deposit.GetOrCreateAddress(ctx, accountID, deposit.DefaultChain)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, addressResponse{
		Address:      addr.Address,
		Chain:        addr.Chain,
		ChainID:      deposit.DefaultChainID,
		USDCContract: deposit.USDCContractBase,
		MinDeposit:   deposit.MinDeposit.StringFixed(6),
	})
}

// =========================================================================
// GET /v1/deposits
// =========================================================================

type depositItem struct {
	DepositID   string `json:"deposit_id"`
	Amount      string `json:"amount"`
	TxHash      string `json:"tx_hash"`
	FromAddress string `json:"from_address"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
}

type depositsResponse struct {
	Deposits []depositItem `json:"deposits"`
}

// ListDeposits returns the user's deposit history.
func (g *Group) ListDeposits(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	deps, err := g.deposit.QueryDeposits(ctx, accountID)
	if err != nil {
		return err
	}

	items := make([]depositItem, 0, len(deps))
	for _, d := range deps {
		items = append(items, depositItem{
			DepositID:   d.DepositID.String(),
			Amount:      d.Amount.StringFixed(6),
			TxHash:      d.TxHash,
			FromAddress: d.FromAddress,
			Status:      d.Status,
			CreatedAt:   d.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}

	return v1.Respond(w, http.StatusOK, depositsResponse{Deposits: items})
}

// =========================================================================
// GET /v1/withdraw/nonce
// =========================================================================

type nonceResponse struct {
	Nonce     string `json:"nonce"`
	ExpiresIn int    `json:"expires_in"`
}

// WithdrawNonce generates a one-time nonce for withdraw signature verification.
func (g *Group) WithdrawNonce(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	_, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	rec, err := g.user.GenerateNonce(ctx)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, nonceResponse{
		Nonce:     rec.Nonce,
		ExpiresIn: 300,
	})
}

// =========================================================================
// POST /v1/withdraw
// =========================================================================

type withdrawRequest struct {
	ToAddress string `json:"to_address"`
	Amount    string `json:"amount"`
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

type withdrawResponse struct {
	WithdrawalID string `json:"withdrawal_id"`
	Status       string `json:"status"`
	Amount       string `json:"amount"`
	Fee          string `json:"fee"`
	NetAmount    string `json:"net_amount"`
	ToAddress    string `json:"to_address"`
	CreatedAt    string `json:"created_at"`
}

// RequestWithdrawal handles a withdrawal request from the user.
// It verifies the user's wallet signature (EIP-191 personal_sign) before
// proceeding with the withdrawal.
func (g *Group) RequestWithdrawal(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	var req withdrawRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.Nonce == "" || req.Signature == "" {
		return v1.NewRequestError(fmt.Errorf("nonce and signature are required"), http.StatusBadRequest)
	}

	amount, err := decimal.NewFromString(req.Amount)
	if err != nil {
		return v1.NewRequestError(err, http.StatusBadRequest)
	}

	// 0. Withdrawals are wallet-signed, so an account with no linked wallet
	// (e.g. the passcode admin, D-007) can never satisfy step 5. Refuse up
	// front, before the nonce is burned, with a message that says why.
	walletAddr, err := g.user.QueryWalletAddress(ctx, accountID)
	if err != nil || walletAddr == "" {
		return v1.NewRequestError(fmt.Errorf("withdrawals require a linked wallet"), http.StatusForbidden)
	}

	// 1. Consume nonce (prevents replay).
	if _, err := g.user.ConsumeNonce(ctx, req.Nonce); err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid or expired nonce"), http.StatusUnauthorized)
	}

	// 2. Validate to_address is a well-formed hex address.
	if _, err := ethereum.NormalizeAddress(req.ToAddress); err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid to_address"), http.StatusBadRequest)
	}

	// 3. Reconstruct the signed message and recover the signer address.
	// IMPORTANT: Use req.ToAddress (raw) — NOT the EIP-55 normalized form —
	// because the client signs with the address as the user typed it.
	// Amount in the signed message is in USDC (real money), not cash coins.
	usdcAmount := amount.Div(deposit.ExchangeRate)
	message := ethereum.FormatWithdrawMessage(req.Nonce, req.ToAddress, usdcAmount.StringFixed(6))
	recoveredAddr, err := ethereum.VerifyPersonalSign(message, req.Signature)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid signature"), http.StatusUnauthorized)
	}

	// 4. Compare recovered address with the bound wallet address (step 0).
	if !strings.EqualFold(recoveredAddr, walletAddr) {
		return v1.NewRequestError(fmt.Errorf("signature does not match wallet"), http.StatusUnauthorized)
	}

	// 6. Proceed with the existing withdrawal logic.
	wr, err := g.deposit.RequestWithdrawal(ctx, accountID, req.ToAddress, amount, deposit.DefaultChain)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, withdrawResponse{
		WithdrawalID: wr.RequestID.String(),
		Status:       wr.Status,
		Amount:       wr.AmountCash.StringFixed(6),
		Fee:          wr.FeeUSDC.StringFixed(6),
		NetAmount:    wr.AmountUSDC.StringFixed(6),
		ToAddress:    wr.ToAddress,
		CreatedAt:    wr.CreatedAt.Format("2006-01-02T15:04:05Z"),
	})
}

// =========================================================================
// GET /v1/withdrawals
// =========================================================================

type withdrawalItem struct {
	WithdrawalID string  `json:"withdrawal_id"`
	Status       string  `json:"status"`
	Amount       string  `json:"amount"`
	Fee          string  `json:"fee"`
	NetAmount    string  `json:"net_amount"`
	ToAddress    string  `json:"to_address"`
	TxHash       *string `json:"tx_hash"`
	CreatedAt    string  `json:"created_at"`
	SubmittedAt  *string `json:"submitted_at,omitempty"`
	ConfirmedAt  *string `json:"confirmed_at,omitempty"`
}

type withdrawalsResponse struct {
	Withdrawals []withdrawalItem `json:"withdrawals"`
}

// ListWithdrawals returns the user's withdrawal history.
func (g *Group) ListWithdrawals(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	wrs, err := g.deposit.QueryWithdrawals(ctx, accountID)
	if err != nil {
		return err
	}

	items := make([]withdrawalItem, 0, len(wrs))
	for _, wr := range wrs {
		item := withdrawalItem{
			WithdrawalID: wr.RequestID.String(),
			Status:       wr.Status,
			Amount:       wr.AmountCash.StringFixed(6),
			Fee:          wr.FeeUSDC.StringFixed(6),
			NetAmount:    wr.AmountUSDC.StringFixed(6),
			ToAddress:    wr.ToAddress,
			TxHash:       wr.TxHash,
			CreatedAt:    wr.CreatedAt.Format("2006-01-02T15:04:05Z"),
		}
		if wr.SubmittedAt != nil {
			s := wr.SubmittedAt.Format("2006-01-02T15:04:05Z")
			item.SubmittedAt = &s
		}
		if wr.ConfirmedAt != nil {
			s := wr.ConfirmedAt.Format("2006-01-02T15:04:05Z")
			item.ConfirmedAt = &s
		}
		items = append(items, item)
	}

	return v1.Respond(w, http.StatusOK, withdrawalsResponse{Withdrawals: items})
}
