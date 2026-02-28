// Admin CLI for database migration and seeding.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/ardanlabs/conf/v3"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

type config struct {
	DB struct {
		User       string `conf:"default:postgres"`
		Password   string `conf:"default:postgres,mask"`
		Host       string `conf:"default:localhost:5432"`
		Name       string `conf:"default:coinpusher"`
		DisableTLS bool   `conf:"default:false"`
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		fmt.Println("Usage: admin <command>")
		fmt.Println("Commands: migrate, seed, set-role")
		return nil
	}

	var cfg config
	if _, err := conf.Parse("BACKEND", &cfg); err != nil {
		if err != conf.ErrHelpWanted {
			return fmt.Errorf("parsing config: %w", err)
		}
	}

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

	switch os.Args[1] {
	case "migrate":
		return migrate(db)
	case "seed":
		return seed(db)
	case "set-role":
		return setRole(db)
	default:
		return fmt.Errorf("unknown command: %s", os.Args[1])
	}
}

func migrate(db *sqlx.DB) error {
	schema, err := os.ReadFile("zarf/docker/database/schema.sql")
	if err != nil {
		return fmt.Errorf("reading schema: %w", err)
	}

	if _, err := db.Exec(string(schema)); err != nil {
		return fmt.Errorf("executing schema: %w", err)
	}

	fmt.Println("migrations complete")
	return nil
}

func setRole(db *sqlx.DB) error {
	// Usage: admin set-role <account-id> <role>
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin set-role <account-id> <role>")
	}

	accountID, err := uuid.Parse(os.Args[2])
	if err != nil {
		return fmt.Errorf("invalid account-id: %w", err)
	}

	role := os.Args[3]
	if role != "user" && role != "admin" {
		return fmt.Errorf("invalid role %q: must be 'user' or 'admin'", role)
	}

	store := userdb.NewStore(db)
	core := user.NewCore(store)

	if err := core.SetRole(context.Background(), accountID, role); err != nil {
		return fmt.Errorf("setting role: %w", err)
	}

	fmt.Printf("account %s role set to %q\n", accountID, role)
	return nil
}

func seed(db *sqlx.DB) error {
	seedData, err := os.ReadFile("zarf/docker/database/seed.sql")
	if err != nil {
		return fmt.Errorf("reading seed: %w", err)
	}

	if _, err := db.Exec(string(seedData)); err != nil {
		return fmt.Errorf("executing seed: %w", err)
	}

	fmt.Println("seed complete")
	return nil
}
