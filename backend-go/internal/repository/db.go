// Package repository provides database access for the Go backend.
//
// Phase 0 uses a thin database/sql abstraction so endpoints can be tested end-to-end
// before Prisma Client Go is generated. The repository interfaces are designed so the
// implementation can be swapped to Prisma Client Go (or GORM) in a later phase without
// changing handlers or services.
package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// DB wraps a *sql.DB with helpers used across repositories.
type DB struct {
	*sql.DB
}

// NewDB opens a MySQL connection from a DSN and verifies it.
func NewDB(dsn string) (*DB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}
	return &DB{DB: db}, nil
}

// Health returns true if the database is reachable.
func (db *DB) Health(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var one int
	if err := db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		return false, err
	}
	return true, nil
}

// Tx runs a function inside a transaction. If the function returns an error,
// the transaction is rolled back.
func (db *DB) Tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		if rerr := tx.Rollback(); rerr != nil {
			return fmt.Errorf("tx error: %v; rollback error: %w", err, rerr)
		}
		return err
	}
	return tx.Commit()
}
