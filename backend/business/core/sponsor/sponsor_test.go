package sponsor

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockStorer struct {
	createFn                func(ctx context.Context, camp Campaign) error
	queryByIDFn             func(ctx context.Context, campaignID uuid.UUID) (Campaign, error)
	queryActiveFn           func(ctx context.Context) ([]Campaign, error)
	decrementPoolFn         func(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error)
	creditBalanceFn         func(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal) error
	createRewardLogFn       func(ctx context.Context, log RewardLog) error
	queryBalancesByAccountFn func(ctx context.Context, accountID uuid.UUID) ([]SponsorBalance, error)
	updateStatusFn          func(ctx context.Context, campaignID uuid.UUID, status string) error
	queryByAccountFn        func(ctx context.Context, accountID uuid.UUID) ([]Campaign, error)
	createQuotaFn           func(ctx context.Context, entry QuotaEntry) error
	consumeQuotaFn          func(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error
	queryStaleQuotasFn      func(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error)
	refundQuotaFn           func(ctx context.Context, quotaID uuid.UUID) error
}

func (m *mockStorer) Create(ctx context.Context, camp Campaign) error {
	if m.createFn != nil {
		return m.createFn(ctx, camp)
	}
	return nil
}

func (m *mockStorer) QueryByID(ctx context.Context, campaignID uuid.UUID) (Campaign, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, campaignID)
	}
	return Campaign{}, nil
}

func (m *mockStorer) QueryActive(ctx context.Context) ([]Campaign, error) {
	if m.queryActiveFn != nil {
		return m.queryActiveFn(ctx)
	}
	return nil, nil
}

func (m *mockStorer) DecrementPool(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
	if m.decrementPoolFn != nil {
		return m.decrementPoolFn(ctx, campaignID, amount)
	}
	return decimal.Zero, nil
}

func (m *mockStorer) CreditBalance(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal) error {
	if m.creditBalanceFn != nil {
		return m.creditBalanceFn(ctx, campaignID, accountID, amount)
	}
	return nil
}

func (m *mockStorer) CreateRewardLog(ctx context.Context, log RewardLog) error {
	if m.createRewardLogFn != nil {
		return m.createRewardLogFn(ctx, log)
	}
	return nil
}

func (m *mockStorer) QueryBalancesByAccount(ctx context.Context, accountID uuid.UUID) ([]SponsorBalance, error) {
	if m.queryBalancesByAccountFn != nil {
		return m.queryBalancesByAccountFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) UpdateStatus(ctx context.Context, campaignID uuid.UUID, status string) error {
	if m.updateStatusFn != nil {
		return m.updateStatusFn(ctx, campaignID, status)
	}
	return nil
}

func (m *mockStorer) QueryByAccount(ctx context.Context, accountID uuid.UUID) ([]Campaign, error) {
	if m.queryByAccountFn != nil {
		return m.queryByAccountFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) CreateQuota(ctx context.Context, entry QuotaEntry) error {
	if m.createQuotaFn != nil {
		return m.createQuotaFn(ctx, entry)
	}
	return nil
}

func (m *mockStorer) ConsumeQuota(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error {
	if m.consumeQuotaFn != nil {
		return m.consumeQuotaFn(ctx, quotaID, coinsSpawned)
	}
	return nil
}

func (m *mockStorer) QueryStaleQuotas(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error) {
	if m.queryStaleQuotasFn != nil {
		return m.queryStaleQuotasFn(ctx, olderThan)
	}
	return nil, nil
}

func (m *mockStorer) RefundQuota(ctx context.Context, quotaID uuid.UUID) error {
	if m.refundQuotaFn != nil {
		return m.refundQuotaFn(ctx, quotaID)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

func TestCreate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		storer  *mockStorer
		input   NewCampaign
		wantErr bool
		check   func(t *testing.T, camp Campaign)
	}{
		{
			name:   "success - creates campaign with correct defaults",
			storer: &mockStorer{},
			input: NewCampaign{
				CreatedBy:     uuid.New(),
				Chain:         "sui",
				TokenAddress:  "0xtoken",
				TokenSymbol:   "FLAME",
				TokenDecimals: 9,
				BrandColor:    "#FF0000",
				BrandName:     "TestBrand",
				PoolTotal:     decimal.NewFromInt(10000),
				RewardPerCoin: decimal.NewFromInt(100),
			},
			wantErr: false,
			check: func(t *testing.T, camp Campaign) {
				t.Helper()
				if camp.CampaignID == uuid.Nil {
					t.Error("campaign should have non-nil UUID")
				}
				if camp.Status != StatusActive {
					t.Errorf("status = %q, want %q", camp.Status, StatusActive)
				}
				if !camp.PoolRemaining.Equal(camp.PoolTotal) {
					t.Errorf("pool_remaining = %s, want %s (same as pool_total)", camp.PoolRemaining, camp.PoolTotal)
				}
				if camp.BrandName != "TestBrand" {
					t.Errorf("brand_name = %q, want %q", camp.BrandName, "TestBrand")
				}
			},
		},
		{
			name: "storer error propagates",
			storer: &mockStorer{
				createFn: func(ctx context.Context, camp Campaign) error {
					return errors.New("db write failed")
				},
			},
			input: NewCampaign{
				CreatedBy:     uuid.New(),
				Chain:         "sui",
				TokenAddress:  "0xtoken",
				TokenSymbol:   "TEST",
				BrandName:     "Err",
				PoolTotal:     decimal.NewFromInt(1000),
				RewardPerCoin: decimal.NewFromInt(10),
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, tt.storer, nil)

			camp, err := core.Create(context.Background(), tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if tt.check != nil {
				tt.check(t, camp)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

func TestGet(t *testing.T) {
	t.Parallel()

	campID := uuid.New()
	expected := Campaign{CampaignID: campID, BrandName: "Found"}

	tests := []struct {
		name    string
		storer  *mockStorer
		wantErr bool
	}{
		{
			name: "success",
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Campaign, error) {
					return expected, nil
				},
			},
			wantErr: false,
		},
		{
			name: "not found",
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Campaign, error) {
					return Campaign{}, errors.New("not found")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, tt.storer, nil)

			camp, err := core.Get(context.Background(), campID)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if !tt.wantErr && camp.CampaignID != campID {
				t.Errorf("CampaignID = %v, want %v", camp.CampaignID, campID)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ListActive
// ---------------------------------------------------------------------------

func TestListActive(t *testing.T) {
	t.Parallel()

	camps := []Campaign{
		{CampaignID: uuid.New(), Status: StatusActive},
		{CampaignID: uuid.New(), Status: StatusActive},
	}

	core := NewCore(nil, &mockStorer{
		queryActiveFn: func(ctx context.Context) ([]Campaign, error) {
			return camps, nil
		},
	}, nil)

	got, err := core.ListActive(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("len = %d, want 2", len(got))
	}
}

// ---------------------------------------------------------------------------
// ListByAccount
// ---------------------------------------------------------------------------

func TestListByAccount(t *testing.T) {
	t.Parallel()

	acctID := uuid.New()
	camps := []Campaign{
		{CampaignID: uuid.New(), CreatedBy: acctID},
	}

	core := NewCore(nil, &mockStorer{
		queryByAccountFn: func(ctx context.Context, id uuid.UUID) ([]Campaign, error) {
			if id != acctID {
				t.Errorf("accountID = %v, want %v", id, acctID)
			}
			return camps, nil
		},
	}, nil)

	got, err := core.ListByAccount(context.Background(), acctID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("len = %d, want 1", len(got))
	}
}

// ---------------------------------------------------------------------------
// Pause / Resume / Expire
// ---------------------------------------------------------------------------

func TestPauseResumeExpire(t *testing.T) {
	t.Parallel()

	campID := uuid.New()

	tests := []struct {
		name       string
		action     func(core *Core) error
		wantStatus string
		storerErr  error
		wantErr    bool
	}{
		{
			name:       "pause success",
			action:     func(c *Core) error { return c.Pause(context.Background(), campID) },
			wantStatus: StatusPaused,
		},
		{
			name:       "resume success",
			action:     func(c *Core) error { return c.Resume(context.Background(), campID) },
			wantStatus: StatusActive,
		},
		{
			name:       "expire success",
			action:     func(c *Core) error { return c.Expire(context.Background(), campID) },
			wantStatus: StatusExpired,
		},
		{
			name:      "pause error propagates",
			action:    func(c *Core) error { return c.Pause(context.Background(), campID) },
			storerErr: errors.New("db error"),
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var gotStatus string
			storer := &mockStorer{
				updateStatusFn: func(ctx context.Context, id uuid.UUID, status string) error {
					gotStatus = status
					if tt.storerErr != nil {
						return tt.storerErr
					}
					return nil
				},
			}
			core := NewCore(nil, storer, nil)

			err := tt.action(core)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if !tt.wantErr && gotStatus != tt.wantStatus {
				t.Errorf("status = %q, want %q", gotStatus, tt.wantStatus)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// DecrementPool
// ---------------------------------------------------------------------------

func TestDecrementPool(t *testing.T) {
	t.Parallel()

	campID := uuid.New()
	amount := decimal.NewFromInt(500)
	remaining := decimal.NewFromInt(9500)

	core := NewCore(nil, &mockStorer{
		decrementPoolFn: func(ctx context.Context, id uuid.UUID, amt decimal.Decimal) (decimal.Decimal, error) {
			if !amt.Equal(amount) {
				t.Errorf("amount = %s, want %s", amt, amount)
			}
			return remaining, nil
		},
	}, nil)

	got, err := core.DecrementPool(context.Background(), campID, amount)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Equal(remaining) {
		t.Errorf("remaining = %s, want %s", got, remaining)
	}
}

// ---------------------------------------------------------------------------
// DistributeReward
// ---------------------------------------------------------------------------

func TestDistributeReward(t *testing.T) {
	t.Parallel()

	campID := uuid.New()
	acctID := uuid.New()
	amount := decimal.NewFromInt(100)

	tests := []struct {
		name    string
		storer  *mockStorer
		wantErr bool
	}{
		{
			name: "success - creates log and credits balance",
			storer: &mockStorer{
				createRewardLogFn: func(ctx context.Context, log RewardLog) error {
					if log.CampaignID != campID {
						t.Errorf("campaignID = %v, want %v", log.CampaignID, campID)
					}
					if log.AccountID != acctID {
						t.Errorf("accountID = %v, want %v", log.AccountID, acctID)
					}
					return nil
				},
				creditBalanceFn: func(ctx context.Context, cid, aid uuid.UUID, amt decimal.Decimal) error {
					return nil
				},
			},
			wantErr: false,
		},
		{
			name: "reward log error propagates",
			storer: &mockStorer{
				createRewardLogFn: func(ctx context.Context, log RewardLog) error {
					return errors.New("duplicate ref_key")
				},
			},
			wantErr: true,
		},
		{
			name: "credit balance error propagates",
			storer: &mockStorer{
				createRewardLogFn: func(ctx context.Context, log RewardLog) error {
					return nil
				},
				creditBalanceFn: func(ctx context.Context, cid, aid uuid.UUID, amt decimal.Decimal) error {
					return errors.New("credit failed")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, tt.storer, nil)

			err := core.DistributeReward(context.Background(), campID, acctID, amount, "ref-123")
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// GetBalances
// ---------------------------------------------------------------------------

func TestGetBalances(t *testing.T) {
	t.Parallel()

	acctID := uuid.New()
	bals := []SponsorBalance{
		{AccountID: acctID, CampaignID: uuid.New(), Balance: decimal.NewFromInt(500)},
	}

	core := NewCore(nil, &mockStorer{
		queryBalancesByAccountFn: func(ctx context.Context, id uuid.UUID) ([]SponsorBalance, error) {
			return bals, nil
		},
	}, nil)

	got, err := core.GetBalances(context.Background(), acctID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("len = %d, want 1", len(got))
	}
	if !got[0].Balance.Equal(decimal.NewFromInt(500)) {
		t.Errorf("balance = %s, want 500", got[0].Balance)
	}
}

// ---------------------------------------------------------------------------
// IssueQuota
// ---------------------------------------------------------------------------

func TestIssueQuota(t *testing.T) {
	t.Parallel()

	campID := uuid.New()
	rewardPerCoin := decimal.NewFromInt(10)
	poolRemaining := decimal.NewFromInt(9900)

	tests := []struct {
		name      string
		coinCount int
		storer    *mockStorer
		wantErr   bool
		check     func(t *testing.T, entry QuotaEntry)
	}{
		{
			name:      "success - issues quota and decrements pool",
			coinCount: 10,
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Campaign, error) {
					return Campaign{CampaignID: campID, RewardPerCoin: rewardPerCoin}, nil
				},
				decrementPoolFn: func(ctx context.Context, id uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
					expected := rewardPerCoin.Mul(decimal.NewFromInt(10))
					if !amount.Equal(expected) {
						t.Errorf("decrement amount = %s, want %s", amount, expected)
					}
					return poolRemaining, nil
				},
				createQuotaFn: func(ctx context.Context, entry QuotaEntry) error {
					return nil
				},
			},
			wantErr: false,
			check: func(t *testing.T, entry QuotaEntry) {
				t.Helper()
				if entry.QuotaID == uuid.Nil {
					t.Error("quota should have non-nil UUID")
				}
				if entry.CoinCount != 10 {
					t.Errorf("coin_count = %d, want 10", entry.CoinCount)
				}
				if entry.Status != QuotaIssued {
					t.Errorf("status = %q, want %q", entry.Status, QuotaIssued)
				}
				expectedAmount := rewardPerCoin.Mul(decimal.NewFromInt(10))
				if !entry.TokenAmount.Equal(expectedAmount) {
					t.Errorf("token_amount = %s, want %s", entry.TokenAmount, expectedAmount)
				}
			},
		},
		{
			name:      "campaign not found",
			coinCount: 5,
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Campaign, error) {
					return Campaign{}, errors.New("not found")
				},
			},
			wantErr: true,
		},
		{
			name:      "pool insufficient",
			coinCount: 5,
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Campaign, error) {
					return Campaign{CampaignID: campID, RewardPerCoin: rewardPerCoin}, nil
				},
				decrementPoolFn: func(ctx context.Context, id uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
					return decimal.Zero, errors.New("insufficient pool")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, tt.storer, nil)

			entry, err := core.IssueQuota(context.Background(), campID, tt.coinCount)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if tt.check != nil {
				tt.check(t, entry)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ConsumeQuota
// ---------------------------------------------------------------------------

func TestConsumeQuota(t *testing.T) {
	t.Parallel()

	quotaID := uuid.New()

	tests := []struct {
		name    string
		storer  *mockStorer
		wantErr bool
	}{
		{
			name:    "success",
			storer:  &mockStorer{},
			wantErr: false,
		},
		{
			name: "error propagates",
			storer: &mockStorer{
				consumeQuotaFn: func(ctx context.Context, id uuid.UUID, spawned int) error {
					return errors.New("already consumed")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, tt.storer, nil)

			err := core.ConsumeQuota(context.Background(), quotaID, 5)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ReconcileStaleQuotas
// ---------------------------------------------------------------------------

func TestReconcileStaleQuotas(t *testing.T) {
	t.Parallel()

	campID := uuid.New()
	quotaID := uuid.New()
	tokenAmount := decimal.NewFromInt(100)

	tests := []struct {
		name    string
		storer  *mockStorer
		wantErr bool
	}{
		{
			name: "no stale quotas",
			storer: &mockStorer{
				queryStaleQuotasFn: func(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error) {
					return nil, nil
				},
			},
			wantErr: false,
		},
		{
			name: "refunds stale quota and restores pool",
			storer: &mockStorer{
				queryStaleQuotasFn: func(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error) {
					return []QuotaEntry{
						{QuotaID: quotaID, CampaignID: campID, TokenAmount: tokenAmount},
					}, nil
				},
				refundQuotaFn: func(ctx context.Context, id uuid.UUID) error {
					if id != quotaID {
						t.Errorf("quotaID = %v, want %v", id, quotaID)
					}
					return nil
				},
				decrementPoolFn: func(ctx context.Context, id uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
					// Should receive negative amount (restoring pool).
					if !amount.Equal(tokenAmount.Neg()) {
						t.Errorf("amount = %s, want %s (negative for restore)", amount, tokenAmount.Neg())
					}
					return decimal.Zero, nil
				},
			},
			wantErr: false,
		},
		{
			name: "query error propagates",
			storer: &mockStorer{
				queryStaleQuotasFn: func(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error) {
					return nil, errors.New("db error")
				},
			},
			wantErr: true,
		},
		{
			name: "refund error propagates",
			storer: &mockStorer{
				queryStaleQuotasFn: func(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error) {
					return []QuotaEntry{
						{QuotaID: quotaID, CampaignID: campID, TokenAmount: tokenAmount},
					}, nil
				},
				refundQuotaFn: func(ctx context.Context, id uuid.UUID) error {
					return errors.New("refund failed")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, tt.storer, nil)

			err := core.ReconcileStaleQuotas(context.Background(), 5*time.Minute)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}
