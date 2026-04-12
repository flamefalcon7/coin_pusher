// Package sponsorgrp provides HTTP handlers for sponsor campaign operations.
package sponsorgrp

import (
	"context"
	"fmt"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/sponsor"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Group holds the handler dependencies.
type Group struct {
	sponsor *sponsor.Core
	log     *zap.SugaredLogger
}

// New constructs a handler Group.
func New(sponsorCore *sponsor.Core, log *zap.SugaredLogger) *Group {
	return &Group{
		sponsor: sponsorCore,
		log:     log,
	}
}

// createRequest is the JSON body for creating a new campaign.
type createRequest struct {
	Chain         string `json:"chain"`
	TokenAddress  string `json:"token_address"`
	TokenSymbol   string `json:"token_symbol"`
	TokenDecimals int    `json:"token_decimals"`
	BrandColor    string `json:"brand_color"`
	BrandName     string `json:"brand_name"`
	LogoURL       string `json:"logo_url"`
	AdImageURL    string `json:"ad_image_url"`
	PoolTotal     string `json:"pool_total"`
	RewardPerCoin string `json:"reward_per_coin"`
}

// Create handles POST /v1/sponsor/campaign.
func (g *Group) Create(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req createRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid account id"), http.StatusBadRequest)
	}

	// Validate required fields.
	if req.Chain == "" {
		return v1.NewRequestError(fmt.Errorf("chain is required"), http.StatusBadRequest)
	}
	if req.TokenAddress == "" {
		return v1.NewRequestError(fmt.Errorf("token_address is required"), http.StatusBadRequest)
	}
	if req.TokenSymbol == "" {
		return v1.NewRequestError(fmt.Errorf("token_symbol is required"), http.StatusBadRequest)
	}
	if req.BrandName == "" {
		return v1.NewRequestError(fmt.Errorf("brand_name is required"), http.StatusBadRequest)
	}

	poolTotal, err := decimal.NewFromString(req.PoolTotal)
	if err != nil || poolTotal.LessThanOrEqual(decimal.Zero) {
		return v1.NewRequestError(fmt.Errorf("pool_total must be a positive decimal"), http.StatusBadRequest)
	}

	rewardPerCoin, err := decimal.NewFromString(req.RewardPerCoin)
	if err != nil || rewardPerCoin.LessThanOrEqual(decimal.Zero) {
		return v1.NewRequestError(fmt.Errorf("reward_per_coin must be a positive decimal"), http.StatusBadRequest)
	}

	nc := sponsor.NewCampaign{
		CreatedBy:     accountID,
		Chain:         req.Chain,
		TokenAddress:  req.TokenAddress,
		TokenSymbol:   req.TokenSymbol,
		TokenDecimals: req.TokenDecimals,
		BrandColor:    req.BrandColor,
		BrandName:     req.BrandName,
		LogoURL:       "", // URLs only set via /upload endpoint
		AdImageURL:    "", // URLs only set via /upload endpoint
		PoolTotal:     poolTotal,
		RewardPerCoin: rewardPerCoin,
	}

	camp, err := g.sponsor.Create(ctx, nc)
	if err != nil {
		return fmt.Errorf("creating campaign: %w", err)
	}

	return v1.Respond(w, http.StatusCreated, camp)
}

// List handles GET /v1/sponsor/campaigns.
func (g *Group) List(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	camps, err := g.sponsor.ListActive(ctx)
	if err != nil {
		return fmt.Errorf("listing campaigns: %w", err)
	}

	if camps == nil {
		camps = []sponsor.Campaign{}
	}

	return v1.Respond(w, http.StatusOK, camps)
}

// GetByID handles GET /v1/sponsor/campaign/{id}.
func (g *Group) GetByID(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	idStr := chi.URLParam(r, "id")
	campaignID, err := uuid.Parse(idStr)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid campaign id"), http.StatusBadRequest)
	}

	camp, err := g.sponsor.Get(ctx, campaignID)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, camp)
}

// uploadResponse is the response for a successful image upload.
type uploadResponse struct {
	LogoURL    string `json:"logo_url,omitempty"`
	AdImageURL string `json:"ad_image_url,omitempty"`
}

// Upload handles POST /v1/sponsor/campaign/{id}/upload.
func (g *Group) Upload(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid account id"), http.StatusBadRequest)
	}

	idStr := chi.URLParam(r, "id")
	campaignID, err := uuid.Parse(idStr)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid campaign id"), http.StatusBadRequest)
	}

	// Verify campaign exists and belongs to the current user.
	camp, err := g.sponsor.Get(ctx, campaignID)
	if err != nil {
		return err
	}
	if camp.CreatedBy != accountID {
		return v1.NewRequestError(fmt.Errorf("forbidden: not campaign owner"), http.StatusForbidden)
	}

	// Limit request body to 512KB.
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	if err := r.ParseMultipartForm(512 * 1024); err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid multipart form or body too large"), http.StatusBadRequest)
	}

	resp := uploadResponse{}

	// Process logo file.
	if logoURL, err := g.processUpload(r, "logo", campaignID); err != nil {
		return err
	} else if logoURL != "" {
		resp.LogoURL = logoURL
	}

	// Process ad_image file.
	if adURL, err := g.processUpload(r, "ad_image", campaignID); err != nil {
		return err
	} else if adURL != "" {
		resp.AdImageURL = adURL
	}

	if resp.LogoURL == "" && resp.AdImageURL == "" {
		return v1.NewRequestError(fmt.Errorf("no files uploaded; provide 'logo' or 'ad_image' field"), http.StatusBadRequest)
	}

	// Persist the URLs to the campaign record so clients see them.
	if err := g.sponsor.UpdateImageURLs(ctx, campaignID, resp.LogoURL, resp.AdImageURL); err != nil {
		return fmt.Errorf("persisting image urls: %w", err)
	}

	return v1.Respond(w, http.StatusOK, resp)
}

// processUpload handles a single file field from the multipart form.
// Returns the generated URL path or empty string if the field is not present.
func (g *Group) processUpload(r *http.Request, fieldName string, campaignID uuid.UUID) (string, error) {
	file, _, err := r.FormFile(fieldName)
	if err != nil {
		if err == http.ErrMissingFile {
			return "", nil
		}
		return "", v1.NewRequestError(fmt.Errorf("reading %s file: %w", fieldName, err), http.StatusBadRequest)
	}
	defer file.Close()

	// Read file content for validation.
	data, err := io.ReadAll(file)
	if err != nil {
		return "", v1.NewRequestError(fmt.Errorf("reading %s file data: %w", fieldName, err), http.StatusBadRequest)
	}

	// Validate magic bytes.
	contentType := http.DetectContentType(data)
	var ext string
	switch contentType {
	case "image/jpeg":
		ext = "jpg"
	case "image/png":
		ext = "png"
	default:
		return "", v1.NewRequestError(fmt.Errorf("unsupported content type %s; only image/jpeg and image/png allowed", contentType), http.StatusBadRequest)
	}

	// Re-decode image to validate it's a real image file.
	// Use a new reader from the data since we already read the file.
	imgReader := io.NopCloser(io.NewSectionReader(readerAt(data), 0, int64(len(data))))
	switch contentType {
	case "image/jpeg":
		if _, err := jpeg.Decode(imgReader); err != nil {
			return "", v1.NewRequestError(fmt.Errorf("invalid JPEG image: %w", err), http.StatusBadRequest)
		}
	case "image/png":
		if _, err := png.Decode(imgReader); err != nil {
			return "", v1.NewRequestError(fmt.Errorf("invalid PNG image: %w", err), http.StatusBadRequest)
		}
	}

	// Generate server-side filename.
	filename := uuid.NewString() + "." + ext
	dir := filepath.Join(".", "uploads", "sponsors", campaignID.String())

	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("creating upload directory: %w", err)
	}

	filePath := filepath.Join(dir, filename)
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return "", fmt.Errorf("writing %s file: %w", fieldName, err)
	}

	urlPath := fmt.Sprintf("/uploads/sponsors/%s/%s", campaignID.String(), filename)
	return urlPath, nil
}

// readerAt wraps a byte slice to implement io.ReaderAt.
type readerAt []byte

func (r readerAt) ReadAt(p []byte, off int64) (n int, err error) {
	if off >= int64(len(r)) {
		return 0, io.EOF
	}
	n = copy(p, r[off:])
	if n < len(p) {
		err = io.EOF
	}
	return
}

// ListMine handles GET /v1/sponsor/campaigns/mine.
func (g *Group) ListMine(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid account id"), http.StatusBadRequest)
	}

	camps, err := g.sponsor.ListByAccount(ctx, accountID)
	if err != nil {
		return fmt.Errorf("listing my campaigns: %w", err)
	}

	if camps == nil {
		camps = []sponsor.Campaign{}
	}

	return v1.Respond(w, http.StatusOK, camps)
}

// Pause handles PUT /v1/admin/sponsor/campaign/{id}/pause.
func (g *Group) Pause(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	idStr := chi.URLParam(r, "id")
	campaignID, err := uuid.Parse(idStr)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid campaign id"), http.StatusBadRequest)
	}

	if err := g.sponsor.Pause(ctx, campaignID); err != nil {
		return fmt.Errorf("pausing campaign: %w", err)
	}

	return v1.Respond(w, http.StatusOK, map[string]string{"status": "paused"})
}

// Resume handles PUT /v1/admin/sponsor/campaign/{id}/resume.
func (g *Group) Resume(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	idStr := chi.URLParam(r, "id")
	campaignID, err := uuid.Parse(idStr)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid campaign id"), http.StatusBadRequest)
	}

	if err := g.sponsor.Resume(ctx, campaignID); err != nil {
		return fmt.Errorf("resuming campaign: %w", err)
	}

	return v1.Respond(w, http.StatusOK, map[string]string{"status": "active"})
}

// Remove handles DELETE /v1/admin/sponsor/campaign/{id}.
func (g *Group) Remove(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	idStr := chi.URLParam(r, "id")
	campaignID, err := uuid.Parse(idStr)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid campaign id"), http.StatusBadRequest)
	}

	if err := g.sponsor.Expire(ctx, campaignID); err != nil {
		return fmt.Errorf("removing campaign: %w", err)
	}

	return v1.Respond(w, http.StatusOK, map[string]string{"status": "expired"})
}

// GetBalances handles GET /v1/sponsor/balances.
func (g *Group) GetBalances(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid account id"), http.StatusBadRequest)
	}

	bals, err := g.sponsor.GetBalances(ctx, accountID)
	if err != nil {
		return fmt.Errorf("getting balances: %w", err)
	}

	if bals == nil {
		bals = []sponsor.SponsorBalance{}
	}

	return v1.Respond(w, http.StatusOK, bals)
}
