---
title: "feat: Sponsor Management UI"
type: feat
status: completed
date: 2026-03-30
reviewed: 2026-09-02
outcome: "Shipped in 108bc25. Pages exist but are commented out of App.tsx since 6d95ff7 (hidden until deposit gate)."
---

# feat: Sponsor Management UI

## Overview

Add two new pages to the game client for managing sponsor campaigns:
1. **Sponsor Page** (`/sponsor`) — self-serve UI for sponsors to create campaigns, upload images, and monitor pool status
2. **Admin Sponsors Page** (`/admin/sponsors`) — internal dashboard to view all campaigns, pause/remove them

Both pages live inside the existing Vite + React client, following the same patterns as ProfilePage and DepositPage (full-screen overlay, dark theme, max-width 480px container).

## Problem Statement

Sponsor campaigns can currently only be created and managed via `curl` / Postman. There is no visual interface for sponsors or admins. This blocks any real sponsor onboarding.

## Proposed Solution

### Page 1: Sponsor Page (`/sponsor`)

**Accessible to:** Any authenticated user

**Sections:**

**A. My Campaigns** (top section)
- List of campaigns created by the current user (`created_by = me`)
- Each campaign shows: brand name, token symbol, brand color swatch, status badge, pool progress bar (`pool_remaining / pool_total`)
- Click a campaign → expand to show details (chain, token address, reward_per_coin, created_at)

**B. Create Campaign** (form below)
- Fields: chain (dropdown: sui/solana), token_address (text), token_symbol (text), token_decimals (number), brand_color (color picker), brand_name (text), pool_total (number), reward_per_coin (number)
- Image uploads: logo + ad_image with drag-and-drop or click-to-select, preview before submit
- Two-step flow: fill form → submit → get campaign_id → upload images → done
- Validation mirrors backend constraints (symbol uppercase max 10, brand_name max 32, color hex, pool_total/reward_per_coin >= 100 coins)
- Success state: show new campaign card with "Active" badge

**C. My Sponsor Balances** (bottom section, for players)
- Shows accumulated sponsor token balances (reuses existing `GET /v1/sponsor/balances`)
- Token symbol + balance amount per campaign

### Page 2: Admin Sponsors Page (`/admin/sponsors`)

**Accessible to:** Users with `role === "admin"` only

**Sections:**

**A. All Campaigns** (full list)
- All campaigns regardless of status (active, depleted, paused, expired)
- Filterable by status
- Each card shows: brand name, token symbol, sponsor account, pool progress, status
- Action buttons: Pause / Resume / Remove (requires new backend endpoints)

**B. Stats Summary** (top)
- Campaign counts by status: active / depleted / paused / expired (derived from the campaign list, no new backend query needed)

### New Files

```
game/client/src/
├── net/SponsorClient.ts          — API client (fetch wrappers)
├── ui/CampaignCard.tsx           — Shared campaign card (used by both pages)
├── ui/CampaignCard.css           — Card styles
├── pages/SponsorPage.tsx         — Sponsor self-serve page
├── pages/SponsorPage.css         — Styles
├── pages/AdminSponsorsPage.tsx   — Admin dashboard
├── pages/AdminSponsorsPage.css   — Styles
```

### Modified Files

```
game/client/src/App.tsx           — Add route checks + conditional mounting
```

### Backend Changes (minimal)

New endpoints needed for admin actions:
```
PUT  /v1/admin/sponsor/campaign/{id}/pause    — set status='paused'
PUT  /v1/admin/sponsor/campaign/{id}/resume   — set status='active'
DELETE /v1/admin/sponsor/campaign/{id}        — set status='expired'
GET  /v1/sponsor/campaigns/mine               — list campaigns by current user
```

Add to `backend/business/core/sponsor/sponsor.go`:
- `Pause(ctx, campaignID)`, `Resume(ctx, campaignID)`, `Expire(ctx, campaignID)`
- `ListByAccount(ctx, accountID)`

Add to `backend/business/core/sponsor/stores/sponsordb/sponsordb.go`:
- `UpdateStatus(ctx, campaignID, status)`, `QueryByAccount(ctx, accountID)`

Add to `backend/app/services/api/handlers/v1/sponsorgrp/sponsorgrp.go`:
- `Pause`, `Resume`, `Remove`, `ListMine` handlers

Add routes to `backend/app/services/api/main.go`:
- Admin routes under `mid.RequireAdmin` middleware

## Technical Approach

### API Client (`SponsorClient.ts`)

Follow `ProfileClient.ts` pattern:

```typescript
// game/client/src/net/SponsorClient.ts

export interface Campaign {
  campaign_id: string;
  created_by: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  brand_color: string;
  brand_name: string;
  logo_url: string;
  ad_image_url: string;
  pool_total: string;
  pool_remaining: string;
  reward_per_coin: string;
  status: string;
  created_at: string;
}

export interface SponsorBalance {
  account_id: string;
  campaign_id: string;
  balance: string;
  updated_at: string;
}

export async function listActiveCampaigns(apiUrl: string): Promise<Campaign[]>
export async function listMyCampaigns(apiUrl: string, token: string): Promise<Campaign[]>
export async function createCampaign(apiUrl: string, token: string, data: NewCampaign): Promise<Campaign>
export async function uploadImages(apiUrl: string, token: string, campaignId: string, logo?: File, adImage?: File): Promise<{logo_url: string, ad_image_url: string}>
export async function getBalances(apiUrl: string, token: string): Promise<SponsorBalance[]>
// Admin
export async function pauseCampaign(apiUrl: string, token: string, id: string): Promise<void>
export async function resumeCampaign(apiUrl: string, token: string, id: string): Promise<void>
export async function removeCampaign(apiUrl: string, token: string, id: string): Promise<void>
```

### Sponsor Page Component Structure

```
SponsorPage
├── PageHeader (back link + title)
├── MyCampaigns
│   └── CampaignCard[] (expandable)
│       ├── BrandColorSwatch
│       ├── StatusBadge (active=green, depleted=orange, paused=gray)
│       └── PoolProgressBar
├── CreateCampaignForm
│   ├── ChainSelect
│   ├── TextInputs (token_address, token_symbol, brand_name)
│   ├── ColorPicker (brand_color)
│   ├── NumberInputs (pool_total, reward_per_coin, token_decimals)
│   ├── ImageUpload × 2 (logo, ad_image) with preview
│   └── SubmitButton
└── MySponsorBalances
    └── BalanceRow[] (token_symbol + amount)
```

### Admin Page Component Structure

```
AdminSponsorsPage
├── PageHeader
├── StatsBar (campaign counts by status)
├── StatusFilter (all / active / depleted / paused / expired)
└── CampaignList
    └── AdminCampaignCard[]
        ├── CampaignCard (reuse from sponsor page)
        ├── SponsorAccountInfo
        └── ActionButtons (Pause / Resume / Remove)
```

### CSS Design

Use existing game theme (dark purple, warm beige text):
- Page background: `var(--bg-deep)` (#1A0E2E)
- Cards: `var(--panel-color)` (#2B1548) with `border-radius: 12px`
- Text: `var(--text-color)` (#F5E6B8)
- Buttons: `linear-gradient(135deg, var(--accent-purple), var(--accent-pink))`
- Status badges: active=`var(--accent-green)`, depleted=`var(--accent-orange)`, paused=gray
- Pool progress bar: `var(--accent-teal)` fill on dark track
- Input fields: semi-transparent dark bg with beige text
- Font: `'Baloo 2', cursive, sans-serif` (same as game)
- Max container width: 480px (same as ProfilePage)
- Image upload area: dashed border, drag-and-drop highlight

### Image Upload UX

```
┌─────────────────────────────────┐
│                                 │
│    📷 Drop image here           │
│    or click to select           │
│                                 │
│    PNG / JPEG, max 512KB        │
│                                 │
└─────────────────────────────────┘
         ↓ after selection
┌─────────────────────────────────┐
│  ┌─────────┐                    │
│  │ preview │  sponsor_logo.png  │
│  │  image  │  256 × 256         │
│  └─────────┘  ✕ Remove          │
└─────────────────────────────────┘
```

### Campaign Creation Flow

```
User fills form
  → Client validates (symbol format, color hex, min coins)
  → POST /v1/sponsor/campaign (creates campaign with empty URLs)
  → On success: POST /v1/sponsor/campaign/{id}/upload (uploads images)
  → On upload success: show new campaign card, refresh list
  → On upload error: campaign exists but has empty image URLs — show warning
    with "Retry Upload" button. Campaign card shows placeholder icon until
    images are successfully uploaded.
  → On create error: show inline error, don't lose form data
```

## Implementation Phases

### Phase 1: Backend Extensions (small)

- [x] Add `ListByAccount`, `UpdateStatus` to sponsor domain
- [x] Add `ListMine`, `Pause`, `Resume`, `Remove` handlers
- [x] Register admin routes with `mid.RequireAdmin`

### Phase 2: API Client + Sponsor Page

- [x] Create `SponsorClient.ts`
- [x] Create `SponsorPage.tsx` + `SponsorPage.css`
  - My Campaigns section with CampaignCard
  - Create Campaign form with validation
  - Image upload with preview
  - My Balances section
- [x] Wire into `App.tsx` routing

### Phase 3: Admin Page

- [x] Create `AdminSponsorsPage.tsx` + `AdminSponsorsPage.css`
  - Stats summary bar
  - Status filter
  - Campaign list with admin actions
- [x] Wire into `App.tsx` routing (admin-only check)

### Phase 4: Navigation

- [x] Add "Sponsor" button to game UI (PlayerInfo action bar)
- [x] Add "Admin: Sponsors" link visible only to admin role
- [ ] Mobile-responsive layout testing

## TODO

> **The entire sponsor system (backend + frontend) has been implemented but NOT tested end-to-end.**
> All phases above need manual QA: campaign CRUD, image upload, admin actions (pause/resume/remove),
> sponsor balance display, navigation flows, and mobile responsiveness.

## Acceptance Criteria

### Functional

- [ ] Sponsor can create campaign with all required fields
- [ ] Sponsor can upload logo + ad image with preview
- [ ] Sponsor sees their campaigns with pool status
- [ ] Sponsor sees their accumulated token balances
- [ ] Admin can view all campaigns across all sponsors
- [ ] Admin can filter by status
- [ ] Admin can pause/resume/remove campaigns
- [ ] Form validation matches backend constraints

### Non-Functional

- [ ] Pages load in < 1s
- [ ] Mobile-responsive (480px breakpoint)
- [ ] No layout shift on image load
- [ ] Follows existing dark theme consistently

## Dependencies

- Existing sponsor backend API (`/v1/sponsor/campaign`, `/campaigns`, `/{id}`, `/{id}/upload`, `/balances`)
- New backend endpoints for admin actions and "my campaigns" list
- Existing auth system (JWT in sessionStorage)
- Existing CSS design system (App.css vars)

## Sources & References

### Internal References

- Page pattern: `game/client/src/pages/ProfilePage.tsx` — full-screen overlay, header, card layout
- API client pattern: `game/client/src/net/ProfileClient.ts` — fetch with Bearer auth
- CSS pattern: `game/client/src/pages/ProfilePage.css` — dark theme, 480px max-width
- Routing pattern: `game/client/src/App.tsx:974-978` — pathname-based conditional rendering
- Auth state: `game/client/src/net/auth.ts` — sessionStorage JWT
- Sponsor API: `backend/app/services/api/handlers/v1/sponsorgrp/sponsorgrp.go`
- Sponsor domain: `backend/business/core/sponsor/sponsor.go`
