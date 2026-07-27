package middleware

import (
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

const rbacContextKey = "rbac"

// SetRBAC stores the RBAC service in the Echo context.
func SetRBAC(c echo.Context, svc services.RBACService) {
	c.Set(rbacContextKey, svc)
}

// GetRBAC retrieves the RBAC service from the Echo context.
func GetRBAC(c echo.Context) services.RBACService {
	if svc, ok := c.Get(rbacContextKey).(services.RBACService); ok {
		return svc
	}
	return nil
}

// RequirePermission returns middleware that checks a module.action permission.
// OWNER short-circuits to allow. ADMIN/MANAGER legacy fallbacks are handled by the service.
func RequirePermission(module, action string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil {
				return shared.ErrUnauthorized(c, "Authentication required")
			}
			if u.IsOwner() {
				return next(c)
			}
			svc := GetRBAC(c)
			if svc == nil {
				return shared.ErrForbidden(c)
			}
			ok, err := svc.HasPermission(c.Request().Context(), u.TenantID, u.UserID, u.Role, module, action)
			if err != nil {
				return shared.ErrInternal(c, err)
			}
			if !ok {
				return shared.ErrForbidden(c)
			}
			return next(c)
		}
	}
}

// RequirePermissionOrRole allows OWNER or a specific permission or one of the listed roles.
func RequirePermissionOrRole(module, action string, roles ...string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil {
				return shared.ErrUnauthorized(c, "Authentication required")
			}
			if u.IsOwner() {
				return next(c)
			}
			for _, r := range roles {
				if u.Role == r {
					return next(c)
				}
			}
			svc := GetRBAC(c)
			if svc == nil {
				return shared.ErrForbidden(c)
			}
			ok, err := svc.HasPermission(c.Request().Context(), u.TenantID, u.UserID, u.Role, module, action)
			if err != nil {
				return shared.ErrInternal(c, err)
			}
			if !ok {
				return shared.ErrForbidden(c)
			}
			return next(c)
		}
	}
}

// RequireRole is kept for simple role checks (e.g., ADMIN/OWNER-only endpoints).
func RequireRole(roles ...string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil {
				return shared.ErrUnauthorized(c, "Authentication required")
			}
			for _, r := range roles {
				if u.Role == r || (r == "ADMIN" && u.IsAdmin()) || (r == "OWNER" && u.IsOwner()) {
					return next(c)
				}
			}
			return shared.ErrForbidden(c)
		}
	}
}
