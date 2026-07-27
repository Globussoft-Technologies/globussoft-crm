package middleware

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

// TenantContextKey is the context key for tenant info.
type tenantContextKey struct{}

// TenantMiddleware resolves tenant-level settings and attaches them to the context.
// Phase 0 stores minimal tenant info; full settings resolution is added later.
func TenantMiddleware(db *sql.DB) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil {
				return next(c)
			}
			tenantID := u.ActiveTenantID
			if tenantID == 0 {
				tenantID = u.TenantID
			}
			if tenantID == 0 {
				tenantID = 1
			}
			tenant := &shared.TenantContext{ID: tenantID}
			if db != nil {
				ctx, cancel := context.WithTimeout(c.Request().Context(), 2*time.Second)
				defer cancel()
				_ = db.QueryRowContext(ctx, "SELECT vertical, defaultCurrency, locale, country FROM Tenant WHERE id = ?", tenantID).
					Scan(&tenant.Vertical, &tenant.DefaultCurrency, &tenant.Locale, &tenant.Country)
			}
			ctx := context.WithValue(c.Request().Context(), tenantContextKey{}, tenant)
			c.SetRequest(c.Request().WithContext(ctx))
			return next(c)
		}
	}
}

// TenantFromContext extracts the tenant context.
func TenantFromContext(ctx context.Context) *shared.TenantContext {
	if t, ok := ctx.Value(tenantContextKey{}).(*shared.TenantContext); ok {
		return t
	}
	return nil
}

// TenantFromEcho extracts the tenant context from an Echo context.
func TenantFromEcho(c echo.Context) *shared.TenantContext {
	return TenantFromContext(c.Request().Context())
}

// TenantScopeSQL returns a tenant-id SQL clause for repositories.
func TenantScopeSQL(tenantID int) string {
	return fmt.Sprintf("tenantId = %d", tenantID)
}
