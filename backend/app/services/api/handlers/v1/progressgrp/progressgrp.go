// Package progressgrp provides HTTP handlers for progress/promotion operations.
package progressgrp

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/progress"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Group holds the handler dependencies.
type Group struct {
	progress *progress.Core
	user     *user.Core
}

// New constructs a handler Group.
func New(progress *progress.Core, user *user.Core) *Group {
	return &Group{progress: progress, user: user}
}

// ==========================================================================
// GET /v1/progress — User: list active progress with current values
// ==========================================================================

type userProgressItem struct {
	ProgressID      string  `json:"progress_id"`
	Title           string  `json:"title"`
	Description     string  `json:"description"`
	MetricType      string  `json:"metric_type"`
	Threshold       string  `json:"threshold"`
	RewardType      string  `json:"reward_type"`
	RewardAmount    string  `json:"reward_amount"`
	CurrentValue    string  `json:"current_value"`
	Status          string  `json:"status"`
	AchievedAt      string  `json:"achieved_at,omitempty"`
	DisbursedAt     string  `json:"disbursed_at,omitempty"`
	ClaimableAt     *string `json:"claimable_at,omitempty"`
	ExpiresAt       *string `json:"expires_at,omitempty"`
}

type userProgressResponse struct {
	Progress []userProgressItem `json:"progress"`
}

// ListUserProgress returns active progress definitions with the user's current values.
func (g *Group) ListUserProgress(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	views, err := g.progress.QueryUserProgress(ctx, accountID)
	if err != nil {
		return err
	}

	items := make([]userProgressItem, 0, len(views))
	for _, v := range views {
		item := userProgressItem{
			ProgressID:   v.ProgressID.String(),
			Title:        v.Title,
			Description:  v.Description,
			MetricType:   v.MetricType,
			Threshold:    v.Threshold.StringFixed(6),
			RewardType:   v.RewardType,
			RewardAmount: v.RewardAmount.StringFixed(6),
			CurrentValue: v.CurrentValue.StringFixed(6),
			Status:       v.Status,
		}
		if v.AchievedAt != nil {
			item.AchievedAt = v.AchievedAt.Format(time.RFC3339)

			// Compute claimable_at: achieved_at + disburse_delay
			claimableAt := v.AchievedAt.Add(v.DisburseDelay)
			s := claimableAt.Format(time.RFC3339)
			item.ClaimableAt = &s

			// Compute expires_at: achieved_at + claim_deadline (if set)
			if v.ClaimDeadline != nil {
				expiresAt := v.AchievedAt.Add(*v.ClaimDeadline)
				s := expiresAt.Format(time.RFC3339)
				item.ExpiresAt = &s
			}
		}
		if v.DisbursedAt != nil {
			item.DisbursedAt = v.DisbursedAt.Format(time.RFC3339)
		}
		items = append(items, item)
	}

	return v1.Respond(w, http.StatusOK, userProgressResponse{Progress: items})
}

// ==========================================================================
// POST /v1/progress/{id}/claim — User: claim a reward
// ==========================================================================

type claimResponse struct {
	Status      string `json:"status"`
	BalancePlay string `json:"balance_play"`
	BalanceCash string `json:"balance_cash"`
}

// ClaimProgress lets a user claim a reward for an achieved progress entry.
func (g *Group) ClaimProgress(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	progressID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid progress id"), http.StatusBadRequest)
	}

	if err := g.progress.ClaimReward(ctx, accountID, progressID); err != nil {
		return v1.NewRequestError(fmt.Errorf("claim failed: %w", err), http.StatusBadRequest)
	}

	// Return updated balances so the frontend can refresh.
	acct, err := g.user.QueryByID(ctx, accountID)
	if err != nil {
		// Claim succeeded but balance fetch failed — still return success.
		return v1.Respond(w, http.StatusOK, claimResponse{Status: "claimed"})
	}

	return v1.Respond(w, http.StatusOK, claimResponse{
		Status:      "claimed",
		BalancePlay: acct.BalancePlay.StringFixed(4),
		BalanceCash: acct.BalanceCash.StringFixed(4),
	})
}

// ==========================================================================
// POST /v1/admin/progress — Admin: create progress definition
// ==========================================================================

type createProgressRequest struct {
	Title            string  `json:"title"`
	Description      string  `json:"description"`
	MetricType       string  `json:"metric_type"`
	Threshold        string  `json:"threshold"`
	RewardType       string  `json:"reward_type"`
	RewardAmount     string  `json:"reward_amount"`
	DisburseDelaySec int     `json:"disburse_delay_sec"`
	ClaimDeadlineSec *int    `json:"claim_deadline_sec"`
	ActiveFrom       *string `json:"active_from"`
	ActiveUntil      *string `json:"active_until"`
}

type progressResponse struct {
	ProgressID      string  `json:"progress_id"`
	Title           string  `json:"title"`
	Description     string  `json:"description"`
	MetricType      string  `json:"metric_type"`
	Threshold       string  `json:"threshold"`
	RewardType      string  `json:"reward_type"`
	RewardAmount    string  `json:"reward_amount"`
	DisburseDelay   int     `json:"disburse_delay_sec"`
	ClaimDeadline   *int    `json:"claim_deadline_sec"`
	ActiveFrom      *string `json:"active_from"`
	ActiveUntil     *string `json:"active_until"`
	Enabled         bool    `json:"enabled"`
	CreatedAt       string  `json:"created_at"`
}

func toProgressResponse(p progress.Progress) progressResponse {
	resp := progressResponse{
		ProgressID:    p.ProgressID.String(),
		Title:         p.Title,
		Description:   p.Description,
		MetricType:    p.MetricType,
		Threshold:     p.Threshold.StringFixed(6),
		RewardType:    p.RewardType,
		RewardAmount:  p.RewardAmount.StringFixed(6),
		DisburseDelay: int(p.DisburseDelay.Seconds()),
		Enabled:       p.Enabled,
		CreatedAt:     p.CreatedAt.Format(time.RFC3339),
	}
	if p.ClaimDeadline != nil {
		sec := int(p.ClaimDeadline.Seconds())
		resp.ClaimDeadline = &sec
	}
	if p.ActiveFrom != nil {
		s := p.ActiveFrom.Format(time.RFC3339)
		resp.ActiveFrom = &s
	}
	if p.ActiveUntil != nil {
		s := p.ActiveUntil.Format(time.RFC3339)
		resp.ActiveUntil = &s
	}
	return resp
}

// CreateProgress creates a new progress definition. Admin only.
func (g *Group) CreateProgress(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	if claims.Role != "admin" {
		return v1.NewForbiddenError()
	}

	var req createProgressRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.Title == "" || req.MetricType == "" || req.RewardType == "" {
		return v1.NewRequestError(fmt.Errorf("title, metric_type, and reward_type are required"), http.StatusBadRequest)
	}

	threshold, err := decimal.NewFromString(req.Threshold)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid threshold: %w", err), http.StatusBadRequest)
	}

	rewardAmount, err := decimal.NewFromString(req.RewardAmount)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid reward_amount: %w", err), http.StatusBadRequest)
	}

	np := progress.NewProgress{
		Title:         req.Title,
		Description:   req.Description,
		MetricType:    req.MetricType,
		Threshold:     threshold,
		RewardType:    req.RewardType,
		RewardAmount:  rewardAmount,
		DisburseDelay: time.Duration(req.DisburseDelaySec) * time.Second,
	}

	if req.ClaimDeadlineSec != nil {
		d := time.Duration(*req.ClaimDeadlineSec) * time.Second
		np.ClaimDeadline = &d
	}

	if req.ActiveFrom != nil {
		t, err := time.Parse(time.RFC3339, *req.ActiveFrom)
		if err != nil {
			return v1.NewRequestError(fmt.Errorf("invalid active_from: %w", err), http.StatusBadRequest)
		}
		np.ActiveFrom = &t
	}
	if req.ActiveUntil != nil {
		t, err := time.Parse(time.RFC3339, *req.ActiveUntil)
		if err != nil {
			return v1.NewRequestError(fmt.Errorf("invalid active_until: %w", err), http.StatusBadRequest)
		}
		np.ActiveUntil = &t
	}

	p, err := g.progress.CreateProgress(ctx, np)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusCreated, toProgressResponse(p))
}

// ==========================================================================
// PUT /v1/admin/progress/{id} — Admin: update progress definition
// ==========================================================================

type updateProgressRequest struct {
	Title            *string `json:"title"`
	Description      *string `json:"description"`
	MetricType       *string `json:"metric_type"`
	Threshold        *string `json:"threshold"`
	RewardType       *string `json:"reward_type"`
	RewardAmount     *string `json:"reward_amount"`
	DisburseDelaySec *int    `json:"disburse_delay_sec"`
	ClaimDeadlineSec *int    `json:"claim_deadline_sec"`
	ActiveFrom       *string `json:"active_from"`
	ActiveUntil      *string `json:"active_until"`
	Enabled          *bool   `json:"enabled"`
}

// UpdateProgress updates an existing progress definition. Admin only.
func (g *Group) UpdateProgress(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	if claims.Role != "admin" {
		return v1.NewForbiddenError()
	}

	progressID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid progress id"), http.StatusBadRequest)
	}

	var req updateProgressRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	var up progress.UpdateProgress
	up.Title = req.Title
	up.Description = req.Description
	up.MetricType = req.MetricType
	up.RewardType = req.RewardType
	up.Enabled = req.Enabled

	if req.Threshold != nil {
		t, err := decimal.NewFromString(*req.Threshold)
		if err != nil {
			return v1.NewRequestError(fmt.Errorf("invalid threshold"), http.StatusBadRequest)
		}
		up.Threshold = &t
	}
	if req.RewardAmount != nil {
		a, err := decimal.NewFromString(*req.RewardAmount)
		if err != nil {
			return v1.NewRequestError(fmt.Errorf("invalid reward_amount"), http.StatusBadRequest)
		}
		up.RewardAmount = &a
	}
	if req.DisburseDelaySec != nil {
		d := time.Duration(*req.DisburseDelaySec) * time.Second
		up.DisburseDelay = &d
	}
	if req.ClaimDeadlineSec != nil {
		d := time.Duration(*req.ClaimDeadlineSec) * time.Second
		up.ClaimDeadline = &d
	}
	if req.ActiveFrom != nil {
		t, err := time.Parse(time.RFC3339, *req.ActiveFrom)
		if err != nil {
			return v1.NewRequestError(fmt.Errorf("invalid active_from"), http.StatusBadRequest)
		}
		up.ActiveFrom = &t
	}
	if req.ActiveUntil != nil {
		t, err := time.Parse(time.RFC3339, *req.ActiveUntil)
		if err != nil {
			return v1.NewRequestError(fmt.Errorf("invalid active_until"), http.StatusBadRequest)
		}
		up.ActiveUntil = &t
	}

	p, err := g.progress.UpdateProgress(ctx, progressID, up)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, toProgressResponse(p))
}

// ==========================================================================
// GET /v1/admin/progress — Admin: list all progress definitions
// ==========================================================================

type adminProgressListResponse struct {
	Progress []progressResponse `json:"progress"`
}

// ListAllProgress returns all progress definitions. Admin only.
func (g *Group) ListAllProgress(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	if claims.Role != "admin" {
		return v1.NewForbiddenError()
	}

	all, err := g.progress.QueryAllProgress(ctx)
	if err != nil {
		return err
	}

	items := make([]progressResponse, 0, len(all))
	for _, p := range all {
		items = append(items, toProgressResponse(p))
	}

	return v1.Respond(w, http.StatusOK, adminProgressListResponse{Progress: items})
}

// ==========================================================================
// GET /v1/admin/progress/{id}/users — Admin: list user progress for monitoring
// ==========================================================================

type accountProgressItem struct {
	AccountID    string  `json:"account_id"`
	CurrentValue string  `json:"current_value"`
	Status       string  `json:"status"`
	AchievedAt   *string `json:"achieved_at,omitempty"`
	DisbursedAt  *string `json:"disbursed_at,omitempty"`
}

type accountProgressListResponse struct {
	Users []accountProgressItem `json:"users"`
}

// ListUserProgressByProgressID returns user progress for a specific progress definition. Admin only.
func (g *Group) ListUserProgressByProgressID(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	if claims.Role != "admin" {
		return v1.NewForbiddenError()
	}

	progressID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid progress id"), http.StatusBadRequest)
	}

	entries, err := g.progress.QueryAccountProgressByProgressID(ctx, progressID)
	if err != nil {
		return err
	}

	items := make([]accountProgressItem, 0, len(entries))
	for _, e := range entries {
		item := accountProgressItem{
			AccountID:    e.AccountID.String(),
			CurrentValue: e.CurrentValue.StringFixed(6),
			Status:       e.Status,
		}
		if e.AchievedAt != nil {
			s := e.AchievedAt.Format(time.RFC3339)
			item.AchievedAt = &s
		}
		if e.DisbursedAt != nil {
			s := e.DisbursedAt.Format(time.RFC3339)
			item.DisbursedAt = &s
		}
		items = append(items, item)
	}

	return v1.Respond(w, http.StatusOK, accountProgressListResponse{Users: items})
}
