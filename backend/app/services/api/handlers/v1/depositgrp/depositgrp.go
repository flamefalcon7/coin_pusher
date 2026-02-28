// Package depositgrp provides HTTP handlers for deposit/withdrawal operations.
package depositgrp

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/deposit"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Group holds the handler dependencies.
type Group struct {
	deposit *deposit.Core
}

// New constructs a handler Group.
func New(deposit *deposit.Core) *Group {
	return &Group{deposit: deposit}
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
// POST /v1/withdraw
// =========================================================================

type withdrawRequest struct {
	ToAddress string `json:"to_address"`
	Amount    string `json:"amount"`
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

	amount, err := decimal.NewFromString(req.Amount)
	if err != nil {
		return v1.NewRequestError(err, http.StatusBadRequest)
	}

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
