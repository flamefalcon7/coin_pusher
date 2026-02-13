# 🪙 Backend Service Implementation Plan (Ardan Labs Layout)

## 1. Project Context

**Goal:** Build a robust Go backend for the Coin Pusher game handling User Auth (SUI/zkLogin), Accounting (Ledger), and Game Event ingestion.
**Architecture Style:** Ardan Labs "Service" Layout (Layered: App -> Business -> Storage -> Foundation).

### Key Tech Stack

- **Language:** Go 1.22+
- **Web Framework:** Standard `net/http` with `foundation/web` (mux) OR `Gin` (wrapped in foundation). _We will use standard lib + chi router for strict Ardan compliance._
- **Database:** PostgreSQL (with `jmoiron/sqlx` or `pgx`).
- **Logging:** Uber Zap.
- **Config:** `ardanlabs/conf`.
- **Blockchain:** SUI Go SDK (`block-vision/sui-go-sdk`).

---

## 2. Directory Structure (Ardan Style)

The strict separation of concerns:

- **`app/`**: Entry points (startup, shutdown, config).
- **`business/`**: Business logic.
- **`core/`**: Pure domain logic (User, Accounting).
- **`data/`**: Database interactions (Stores).
- **`web/`**: HTTP layer helpers (Middleware, Auth).

- **`foundation/`**: Libraries that don't depend on business logic (Logger, Keystore, Blockchain Client).

```text
coin-pusher-backend/
├── app/
│   ├── services/
│   │   └── api/                 # The Main API Server
│   │       ├── main.go
│   │       └── handlers/        # HTTP Handlers (User, Game, Payment)
│   │           ├── v1/
│   │           │   ├── usergrp/
│   │           │   └── gamegrp/
│   │           └── debug/
│   └── tooling/
│       ├── admin/               # CLI for DB migration/seeding
│       └── indexer/             # Standalone SUI Chain Listener
│           └── main.go
├── business/
│   ├── core/                    # Domain Logic
│   │   ├── user/                # User Domain (Login, Create)
│   │   │   ├── stores/          # Interface for DB
│   │   │   │   └── userdb/      # PostgreSQL implementation
│   │   │   └── user.go          # Structs & Logic
│   │   └── accounting/          # Ledger Domain (Deposit, Balance)
│   │       ├── stores/
│   │       │   └── ledgerdb/
│   │       └── accounting.go
│   ├── web/                     # Web Framework Extensions
│   │   ├── auth/                # JWT & SUI Signature verification
│   │   ├── mid/                 # Middleware (Logger, Errors, Panics)
│   │   └── v1/                  # Response helpers
├── foundation/
│   ├── database/                # Postgres connection setup
│   ├── logger/                  # Zap logger wrapper
│   ├── keystore/                # RSA/JWT key management
│   └── blockchain/
│       └── sui/                 # SUI SDK wrapper
└── zarf/                        # Configuration & Deploy
    ├── docker/
    └── k8s/

```

---

## 3. Database Schema (PostgreSQL)

_Managed via `business/data/schema` (Go migration files) or SQL files in `zarf`._

```sql
-- users table
CREATE TABLE users (
    user_id       UUID PRIMARY KEY,
    name          TEXT,
    sui_address   TEXT UNIQUE,
    zklogin_sub   TEXT,
    balance_coin  NUMERIC(20, 4) DEFAULT 0,
    balance_usdc  NUMERIC(20, 4) DEFAULT 0,
    created_at    TIMESTAMP,
    updated_at    TIMESTAMP
);

-- accounting_log (Double entry bookkeeping style log)
CREATE TABLE accounting_logs (
    log_id        UUID PRIMARY KEY,
    user_id       UUID REFERENCES users(user_id),
    action_type   TEXT, -- 'DEPOSIT', 'WITHDRAW', 'GAME_INSERT', 'GAME_REWARD'
    amount        NUMERIC(20, 4),
    currency      TEXT, -- 'USDC', 'COIN'
    reference_id  TEXT, -- TxHash or GameSessionID
    created_at    TIMESTAMP
);

```

---

## 4. Execution Phases for AI Agent

### Phase 1: Skeleton & Foundation

**Goal:** Get the project structure in place, logger running, and configuration loaded.

- [ ] Initialize `go mod init github.com/yourname/coin-pusher`.
- [ ] Create directory structure `app/services/api`, `business/core`, `foundation/logger`.
- [ ] Implement `foundation/logger` using Zap.
- [ ] Implement `app/services/api/main.go` using `ardanlabs/conf` to parse flags/env.
- [ ] create `makefile` with `run`, `build`, `tidy`.

### Phase 2: Database Layer & Tooling

**Goal:** Connect to Postgres and handle migrations.

- [ ] Implement `foundation/database` (Open/Close DB).
- [ ] Create `app/tooling/admin` for running schema migrations (use `golang-migrate` or `darwin`).
- [ ] Create SQL files for `users` and `accounting_logs`.
- [ ] Verify connection via `make admin-migrate`.

### Phase 3: Domain - User & Auth (The SUI Logic)

**Goal:** Allow users to register/login via SUI Address.

- [ ] **Data Layer:** Implement `business/core/user/stores/userdb`.
- Methods: `Create`, `QueryBySUIAddress`, `UpdateBalance`.

- [ ] **Core Logic:** Implement `business/core/user`.
- Logic: If SUI address exists -> return User; else -> Create User.

- [ ] **Auth Foundation:** Implement `business/web/auth`.
- Function: `VerifySUISignature(address, message, signature)`.
- Function: `GenerateJWT(userID)`.

- [ ] **Handler:** Implement `app/services/api/handlers/v1/usergrp`.
- Endpoint: `POST /v1/auth/login`.

### Phase 4: Domain - Accounting & SUI Indexer

**Goal:** Handle Deposits from SUI Chain.

- [ ] **SUI Wrapper:** Implement `foundation/blockchain/sui` to fetch transaction details.
- [ ] **Indexer Service:** Create `app/services/indexer/main.go`.
- Logic: Loop periodically, check SUI Move Contract events.
- On Event: Call `business/core/accounting.Deposit()`.

- [ ] **Accounting Logic:** Implement `business/core/accounting`.
- Method: `ProcessDeposit(userID, amount, txHash)`.
- Logic: Transactionally update `users.balance_usdc` and insert `accounting_logs`.

### Phase 5: Game API (Integration)

**Goal:** API for the game service to report coin usage.

- [ ] **Handler:** Implement `app/services/api/handlers/v1/gamegrp`.
- Endpoint: `POST /v1/game/event`.
- Payload: `{ "user_id": "...", "type": "INSERT_COIN", "count": 1 }`.

- [ ] **Logic:**
- `user.UpdateBalance` (decrement Coin).
- _Note:_ In Ardan layout, this belongs in `business/core/game` which orchestrates calls to `user` and `accounting`.

---

## 5. Key Ardan-Style Rules for the AI

1. **No Global State:** Do not use global variables for DB or Logger. Inject them into the Handlers/Core.
2. **Package Oriented Design:** Do not create a "utils" or "common" package. If code is specific to the `user` domain, put it in `business/core/user`. If it's general platform code, put it in `foundation`.
3. **Error Handling:** Use wrapped errors to provide context (e.g., `fmt.Errorf("querying user: %w", err)`).
4. **Configuration:** Use the `app/services/api/main.go` to construct all dependencies and pass them down.
