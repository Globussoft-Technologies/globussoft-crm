package services

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"
)

// Permission represents a single "module.action" grant.
type Permission string

// RBACService resolves effective permissions for a user/tenant.
// It mirrors the Node.js requirePermission middleware logic.
type RBACService interface {
	GetPermissions(ctx context.Context, tenantID, userID int, userRole string) (map[Permission]struct{}, error)
	HasPermission(ctx context.Context, tenantID, userID int, userRole, module, action string) (bool, error)
}

// rbacSvc implements RBACService with a 30-second in-memory cache.
type rbacSvc struct {
	db        *sql.DB
	cache     map[string]cacheEntry
	cacheMu   sync.RWMutex
	cacheTTL  time.Duration
}

type cacheEntry struct {
	perms     map[Permission]struct{}
	timestamp time.Time
}

// NewRBACService returns an RBACService.
func NewRBACService(db *sql.DB) RBACService {
	return &rbacSvc{
		db:       db,
		cache:    make(map[string]cacheEntry),
		cacheTTL: 30 * time.Second,
	}
}

func cacheKey(tenantID, userID int) string {
	return fmt.Sprintf("%d::%d", tenantID, userID)
}

func (s *rbacSvc) GetPermissions(ctx context.Context, tenantID, userID int, userRole string) (map[Permission]struct{}, error) {
	key := cacheKey(tenantID, userID)
	s.cacheMu.RLock()
	entry, ok := s.cache[key]
	s.cacheMu.RUnlock()
	if ok && time.Since(entry.timestamp) < s.cacheTTL {
		return entry.perms, nil
	}

	perms, err := s.loadPermissions(ctx, tenantID, userID, userRole)
	if err != nil {
		return nil, err
	}

	s.cacheMu.Lock()
	s.cache[key] = cacheEntry{perms: perms, timestamp: time.Now()}
	s.cacheMu.Unlock()
	return perms, nil
}

func (s *rbacSvc) HasPermission(ctx context.Context, tenantID, userID int, userRole, module, action string) (bool, error) {
	perms, err := s.GetPermissions(ctx, tenantID, userID, userRole)
	if err != nil {
		return false, err
	}
	_, ok := perms[Permission(module+"."+action)]
	return ok, nil
}

func (s *rbacSvc) loadPermissions(ctx context.Context, tenantID, userID int, userRole string) (map[Permission]struct{}, error) {
	perms := make(map[Permission]struct{})

	// Query role permissions via UserRole -> Role -> RolePermission.
	rows, err := s.db.QueryContext(ctx, `
		SELECT rp.module, rp.action
		FROM UserRole ur
		JOIN Role r ON r.id = ur.roleId
		LEFT JOIN RolePermission rp ON rp.roleId = r.id
		WHERE ur.userId = ?
		  AND (r.tenantId = ? OR r.tenantId IS NULL)
	`, userID, tenantID)
	if err != nil {
		return nil, fmt.Errorf("rbac query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var module, action sql.NullString
		if err := rows.Scan(&module, &action); err != nil {
			return nil, fmt.Errorf("rbac scan: %w", err)
		}
		if module.Valid && action.Valid {
			perms[Permission(module.String+"."+action.String)] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rbac rows: %w", err)
	}

	// Self-heal legacy ADMIN users: if no permissions and userRole is ADMIN, grant all.
	if len(perms) == 0 {
		legacy := legacyPermissions(userRole)
		for p := range legacy {
			perms[p] = struct{}{}
		}
	}

	return perms, nil
}

// legacyPermissions returns a fallback set for legacy pre-RBAC users.
// In Phase 0 this is a simplified ADMIN=ALL fallback; Phase 1 expands to the full catalog.
func legacyPermissions(userRole string) map[Permission]struct{} {
	role := ""
	if userRole != "" {
		role = userRole
	}
	roleUpper := ""
	for _, r := range role {
		if r >= 'a' && r <= 'z' {
			roleUpper += string(r - 'a' + 'A')
		} else {
			roleUpper += string(r)
		}
	}
	if roleUpper == "ADMIN" || roleUpper == "OWNER" {
		return map[Permission]struct{}{
			"*.*": {},
		}
	}
	return nil
}
