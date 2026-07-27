package repository

import (
	"context"
	"database/sql"
	"time"
)

// RevokedTokenRepository checks whether a JWT ID (jti) has been revoked.
// This mirrors the Node.js prisma.revokedToken.findUnique check.
type RevokedTokenRepository interface {
	IsRevoked(ctx context.Context, jti string) (bool, error)
}

// revokedTokenRepo is a database/sql implementation.
type revokedTokenRepo struct {
	db *DB
}

// NewRevokedTokenRepository returns a RevokedTokenRepository backed by database/sql.
func NewRevokedTokenRepository(db *DB) RevokedTokenRepository {
	return &revokedTokenRepo{db: db}
}

func (r *revokedTokenRepo) IsRevoked(ctx context.Context, jti string) (bool, error) {
	var id int
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err := r.db.QueryRowContext(ctx, "SELECT id FROM RevokedToken WHERE jti = ?", jti).Scan(&id)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
