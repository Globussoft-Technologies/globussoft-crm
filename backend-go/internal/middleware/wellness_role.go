package middleware

import (
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

// WellnessRoleConfig holds options for the wellness role gate.
type WellnessRoleConfig struct {
	Allowed           []string
	Deny              []string
	AnyOfPermissions  []struct{ Module, Action string }
}

// WellnessRole returns middleware that gates wellness-vertical routes.
// It mirrors backend/middleware/wellnessRole.js with a simplified Phase 0 implementation:
//   - tenant vertical must be "wellness"
//   - ADMIN/MANAGER bypass if "admin"/"manager" are in allowed
//   - literal wellnessRole match
//   - clinical/anyOfPermissions backdoors are stubbed and logged for Phase 1.
func WellnessRole(cfg WellnessRoleConfig) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil {
				return shared.ErrUnauthorized(c, "Authentication required")
			}
			tenant := TenantFromEcho(c)
			if tenant == nil || tenant.Vertical != "wellness" {
				return c.JSON(403, shared.APIError{
					Error: "You don't have permission to perform this action. Contact your administrator.",
					Code:  "WELLNESS_TENANT_REQUIRED",
				})
			}
			if contains(cfg.Allowed, "admin") && u.IsAdmin() {
				return next(c)
			}
			if contains(cfg.Allowed, "manager") && u.Role == "MANAGER" {
				return next(c)
			}
			if u.WellnessRole != "" && contains(cfg.Allowed, u.WellnessRole) {
				return next(c)
			}
			if u.WellnessRole != "" && contains(cfg.Deny, u.WellnessRole) {
				return c.JSON(403, shared.APIError{
					Error: "You don't have permission to perform this action. Contact your administrator.",
					Code:  "WELLNESS_ROLE_FORBIDDEN",
					Detail: "wellnessRole denied: " + u.WellnessRole,
				})
			}
			if contains(cfg.Allowed, "clinical") && u.WellnessRole != "" {
				// Phase 1: lookup WellnessRoleType.canTakeVisits from DB.
				// For now, only statically-known clinical roles pass.
				clinical := []string{"doctor", "professional"}
				if contains(clinical, u.WellnessRole) {
					return next(c)
				}
			}
			if len(cfg.AnyOfPermissions) > 0 {
				// Phase 1: check RBAC service anyOfPermissions.
			}
			return c.JSON(403, shared.APIError{
				Error: "You don't have permission to perform this action. Contact your administrator.",
				Code:  "WELLNESS_ROLE_FORBIDDEN",
			})
		}
	}
}

func contains(list []string, item string) bool {
	for _, s := range list {
		if s == item {
			return true
		}
	}
	return false
}
