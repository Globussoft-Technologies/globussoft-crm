package shared

import (
	"context"
	"net/http"

	"github.com/labstack/echo/v4"
)

// contextKey is a private type for context keys to avoid collisions.
type contextKey int

const (
	userContextKey contextKey = iota
	requestIDKey
)

// UserContext is the authenticated user attached to the request.
// It mirrors the JWT payload used by the Node.js backend.
type UserContext struct {
	Owner            bool   `json:"isOwner"`
	UserID           int    `json:"userId"`
	TenantID         int    `json:"tenantId"`
	Role             string `json:"role"`
	UserType         string `json:"userType"`
	Email            string `json:"email"`
	Name             string `json:"name"`
	JTI              string `json:"jti,omitempty"`
	Awaiting2FA      bool   `json:"awaiting2FA"`
	ActiveTenantID   int    `json:"activeTenantId,omitempty"`
	WellnessRole     string `json:"wellnessRole,omitempty"`
	SubBrandAccess   []int  `json:"subBrandAccess,omitempty"`
	PermissionsCache string `json:"-"`
}

// TenantContext holds tenant-level settings resolved for the request.
// Populated by tenant middleware after auth.
type TenantContext struct {
	ID              int    `json:"id"`
	Vertical        string `json:"vertical"`
	DefaultCurrency string `json:"defaultCurrency"`
	Locale          string `json:"locale"`
	Country         string `json:"country"`
	Timezone        string `json:"timezone"`
}

// WithUser stores a UserContext in the standard context.
func WithUser(ctx context.Context, u *UserContext) context.Context {
	return context.WithValue(ctx, userContextKey, u)
}

// UserFromContext extracts the UserContext from a standard context.
func UserFromContext(ctx context.Context) *UserContext {
	if u, ok := ctx.Value(userContextKey).(*UserContext); ok {
		return u
	}
	return nil
}

// UserFromEcho extracts the UserContext from an Echo context.
func UserFromEcho(c echo.Context) *UserContext {
	return UserFromContext(c.Request().Context())
}

// RequireUser returns the user or aborts with a 401 response.
func RequireUser(c echo.Context) (*UserContext, error) {
	u := UserFromEcho(c)
	if u == nil {
		_ = ErrResponse(c, http.StatusUnauthorized, CodeUnauthorized, "Authentication required")
		return nil, NewHTTPError(http.StatusUnauthorized, CodeUnauthorized, "Authentication required")
	}
	return u, nil
}

// WithRequestID attaches a request ID to the context.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestIDFromContext returns the request ID from the context.
func RequestIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}

// IsOwner returns true if the user has the OWNER role.
func (u *UserContext) IsOwner() bool {
	return u.Owner || u.Role == "OWNER"
}

// IsAdmin returns true if the user has an ADMIN or OWNER role.
func (u *UserContext) IsAdmin() bool {
	return u.Role == "ADMIN" || u.Role == "OWNER" || u.IsOwner()
}

// IsStaff returns true if the user is not a portal/customer actor.
func (u *UserContext) IsStaff() bool {
	return u.UserType == "" || u.UserType == "STAFF"
}
