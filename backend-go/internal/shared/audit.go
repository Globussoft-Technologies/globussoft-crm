package shared

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// SQLExecer is the minimal database/sql interface needed by WriteAudit.
type SQLExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// WriteAudit inserts a best-effort audit row. Errors are logged and returned
// so callers can choose whether to fail the operation; mutations should still
// succeed even when audit logging is unavailable.
func WriteAudit(ctx context.Context, db SQLExecer, entity, action string, entityID, userID, tenantID int, details string) error {
	if db == nil {
		return nil
	}
	_, err := db.ExecContext(ctx, `
		INSERT INTO AuditLog (action, entity, entityId, details, createdAt, tenantId, userId)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		action, entity, entityID, details, time.Now(), tenantID, userID,
	)
	return err
}

// GenesisFor returns the canonical chain-head sentinel for a tenant.
// It mirrors backend/lib/audit.js genesisFor(tenantId).
func GenesisFor(tenantID int) string {
	return fmt.Sprintf("GENESIS_%d", tenantID)
}

// Canonicalize returns a deterministic JSON-like string for a value.
// Object keys are sorted; arrays keep order. This must match Node.js exactly.
func Canonicalize(value any) string {
	if value == nil {
		return "null"
	}
	switch v := value.(type) {
	case string:
		return fmt.Sprintf("%q", v)
	case int:
		return fmt.Sprintf("%d", v)
	case int64:
		return fmt.Sprintf("%d", v)
	case float64:
		return fmt.Sprintf("%v", v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case time.Time:
		return fmt.Sprintf("%q", v.UTC().Format(time.RFC3339Nano))
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s:%s", Canonicalize(k), Canonicalize(v[k])))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			parts = append(parts, Canonicalize(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		// Fallback for unknown types: use JSON-ish formatting via fmt.
		return fmt.Sprintf("%q", fmt.Sprintf("%v", v))
	}
}

// ComputeAuditHash computes the tamper-evidence hash for an audit row.
// It mirrors backend/lib/audit.js computeHash(prevHash, payload).
func ComputeAuditHash(prevHash string, tenantID int, action, entity string, entityID, userID *int, details *string, createdAt time.Time) string {
	payload := map[string]any{
		"tenantId":  tenantID,
		"entity":    entity,
		"action":    action,
		"entityId":  nil,
		"userId":    nil,
		"details":   nil,
		"createdAt": createdAt.UTC().Format(time.RFC3339Nano),
	}
	if entityID != nil {
		payload["entityId"] = *entityID
	}
	if userID != nil {
		payload["userId"] = *userID
	}
	if details != nil {
		payload["details"] = *details
	}
	safePrev := prevHash
	if safePrev == "" {
		safePrev = GenesisFor(tenantID)
	}
	h := sha256.New()
	_, _ = h.Write([]byte(safePrev + Canonicalize(payload)))
	return fmt.Sprintf("%x", h.Sum(nil))
}
