package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
)

// AuditLog mirrors the Prisma AuditLog model.
type AuditLog struct {
	ID        int        `json:"id"`
	Action    string     `json:"action"`
	Entity    string     `json:"entity"`
	EntityID  *int       `json:"entityId"`
	Details   *string    `json:"details"`
	CreatedAt time.Time  `json:"createdAt"`
	PrevHash  *string    `json:"prevHash"`
	Hash      *string    `json:"hash"`
	TenantID  int        `json:"tenantId"`
	UserID    *int       `json:"userId"`
	User      *AuditUser `json:"user,omitempty"`
}

// AuditUser is a minimal user projection joined to audit logs.
type AuditUser struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// AuditListParams filters for listing audit logs.
type AuditListParams struct {
	TenantID int
	Entity   string
	Action   string
	Limit    int
}

// AuditVerifyParams holds parameters for chain verification.
type AuditVerifyParams struct {
	TenantID int
}

// AuditRepository defines audit data access.
// This interface can be backed by database/sql (Phase 0) or Prisma Client Go (later).
type AuditRepository interface {
	List(ctx context.Context, p AuditListParams) ([]AuditLog, error)
	VerifyChain(ctx context.Context, tenantID int) (*AuditVerifyResult, error)
}

// AuditVerifyResult reports the integrity walk outcome.
type AuditVerifyResult struct {
	ChainLength        int     `json:"chainLength"`
	TotalRows          int     `json:"totalRows"`
	UnhashedRows       int     `json:"unhashedRows"`
	BrokenAt           *int    `json:"brokenAt"`
	Reason             *string `json:"reason"`
	IntegrityVerified bool    `json:"integrityVerified"`
}

// auditRepo is the database/sql implementation of AuditRepository.
type auditRepo struct {
	db *DB
}

// NewAuditRepository returns an AuditRepository backed by database/sql.
func NewAuditRepository(db *DB) AuditRepository {
	return &auditRepo{db: db}
}

// List returns audit logs for a tenant with optional entity/action filtering.
func (r *auditRepo) List(ctx context.Context, p AuditListParams) ([]AuditLog, error) {
	if p.Limit <= 0 || p.Limit > 1000 {
		p.Limit = 100
	}

	where := []string{"a.tenantId = ?"}
	args := []any{p.TenantID}
	if p.Entity != "" {
		where = append(where, "a.entity = ?")
		args = append(args, p.Entity)
	}
	if p.Action != "" {
		where = append(where, "a.action = ?")
		args = append(args, p.Action)
	}

	query := fmt.Sprintf(`
		SELECT a.id, a.action, a.entity, a.entityId, a.details, a.createdAt, a.prevHash, a.hash, a.tenantId, a.userId,
			u.id AS userId, u.name AS userName, u.email AS userEmail
		FROM AuditLog a
		LEFT JOIN User u ON u.id = a.userId
		WHERE %s
		ORDER BY a.createdAt DESC, a.id DESC
		LIMIT ?`, strings.Join(where, " AND "))
	args = append(args, p.Limit)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("audit list query: %w", err)
	}
	defer rows.Close()

	var logs []AuditLog
	for rows.Next() {
		var log AuditLog
		var userID sql.NullInt64
		var userNameStr, userEmailStr sql.NullString
		if err := rows.Scan(
			&log.ID, &log.Action, &log.Entity, &log.EntityID, &log.Details, &log.CreatedAt, &log.PrevHash, &log.Hash, &log.TenantID, &log.UserID,
			&userID, &userNameStr, &userEmailStr,
		); err != nil {
			return nil, fmt.Errorf("audit list scan: %w", err)
		}
		if userNameStr.Valid || userEmailStr.Valid {
			log.User = &AuditUser{
				ID:    int(userID.Int64),
				Name:  userNameStr.String,
				Email: userEmailStr.String,
			}
		}
		logs = append(logs, log)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("audit list rows: %w", err)
	}
	return logs, nil
}

// VerifyChain walks the audit chain for a tenant and checks integrity.
func (r *auditRepo) VerifyChain(ctx context.Context, tenantID int) (*AuditVerifyResult, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, action, entity, entityId, userId, details, createdAt, prevHash, hash
		FROM AuditLog
		WHERE tenantId = ?
		ORDER BY createdAt ASC, id ASC`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("audit verify query: %w", err)
	}
	defer rows.Close()

	var chain []AuditLog
	for rows.Next() {
		var log AuditLog
		if err := rows.Scan(&log.ID, &log.Action, &log.Entity, &log.EntityID, &log.UserID, &log.Details, &log.CreatedAt, &log.PrevHash, &log.Hash); err != nil {
			return nil, fmt.Errorf("audit verify scan: %w", err)
		}
		chain = append(chain, log)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("audit verify rows: %w", err)
	}

	res := &AuditVerifyResult{
		TotalRows: len(chain),
	}
	if len(chain) == 0 {
		res.IntegrityVerified = true
		return res, nil
	}

	lastHash := ""
	for i, row := range chain {
		res.ChainLength = i + 1

		if row.Hash == nil || *row.Hash == "" {
			res.UnhashedRows++
			brokenID := row.ID
			res.BrokenAt = &brokenID
			reason := "null hash — row was never chained (run backfill)"
			res.Reason = &reason
			break
		}

		expectedPrev := shared.GenesisFor(tenantID)
		if lastHash != "" {
			expectedPrev = lastHash
		}
		if row.PrevHash == nil || *row.PrevHash != expectedPrev {
			brokenID := row.ID
			res.BrokenAt = &brokenID
			reason := fmt.Sprintf("prevHash mismatch (expected %s, got %s)", expectedPrev, stringPtr(row.PrevHash))
			res.Reason = &reason
			break
		}

		recomputed := shared.ComputeAuditHash(lastHash, tenantID, row.Action, row.Entity, row.EntityID, row.UserID, row.Details, row.CreatedAt)
		if recomputed != *row.Hash {
			brokenID := row.ID
			res.BrokenAt = &brokenID
			reason := "hash mismatch (row content tampered)"
			res.Reason = &reason
			break
		}

		lastHash = *row.Hash
	}

	// Count remaining unhashed rows after the break for the UI banner.
	if res.BrokenAt != nil {
		for i := res.ChainLength; i < len(chain); i++ {
			if chain[i].Hash == nil || *chain[i].Hash == "" {
				res.UnhashedRows++
			}
		}
	}

	res.IntegrityVerified = res.BrokenAt == nil
	return res, nil
}

func stringPtr(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}
