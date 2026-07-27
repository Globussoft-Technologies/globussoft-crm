package middleware

import (
	"fmt"
	"strings"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/sirupsen/logrus"
)

const (
	authTokenCookie = "auth_token"
	stepUpTokenKind = "step-up"
)

// JWTClaims maps the claims used by the Node.js backend.
type JWTClaims struct {
	UserID         int    `json:"userId"`
	TenantID       int    `json:"tenantId"`
	Role           string `json:"role"`
	Owner          bool   `json:"isOwner"`
	UserType       string `json:"userType"`
	Email          string `json:"email"`
	Name           string `json:"name"`
	JTI            string `json:"jti"`
	Awaiting2FA    bool   `json:"awaiting2FA"`
	PatientID      *int   `json:"patientId,omitempty"`
	WellnessRole   string `json:"wellnessRole,omitempty"`
	SubBrandAccess []int  `json:"subBrandAccess,omitempty"`
	Kind           string `json:"kind,omitempty"`
	jwt.RegisteredClaims
}

// AuthConfig holds dependencies for auth middleware.
type AuthConfig struct {
	JWTSecret          string
	RevokedTokenRepo   repository.RevokedTokenRepository
	Logger             *logrus.Logger
}

// Auth returns Echo middleware that validates JWT tokens.
func Auth(cfg *AuthConfig) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if isOpenPath(c.Request().URL.Path) {
				return next(c)
			}

			token, err := extractToken(c)
			if err != nil {
				return shared.ErrUnauthorized(c, err.Error())
			}

			claims, err := parseToken(token, cfg.JWTSecret)
			if err != nil {
				if err == jwt.ErrTokenExpired {
					return shared.ErrUnauthorized(c, "Session expired, please log in again")
				}
				return shared.ErrUnauthorized(c, "Invalid Authentication Token")
			}

			if claims.Kind == stepUpTokenKind {
				return shared.ErrUnauthorized(c, "Invalid Authentication Token")
			}

			if claims.PatientID != nil || claims.UserID == 0 {
				return shared.ErrUnauthorized(c, "Invalid staff token (portal tokens are not allowed here)")
			}

			if claims.Awaiting2FA {
				return shared.ErrUnauthorized(c, "Two-factor authentication required. Complete 2FA verification first.")
			}

			if claims.JTI != "" && cfg.RevokedTokenRepo != nil {
				revoked, err := cfg.RevokedTokenRepo.IsRevoked(c.Request().Context(), claims.JTI)
				if err == nil && revoked {
					return shared.ErrUnauthorized(c, "Session revoked. Please log in again.")
				}
				if err != nil && cfg.Logger != nil {
					cfg.Logger.Warnf("revoked-token lookup failed: %v", err)
				}
			}

			activeTenantID := claims.TenantID
			if h := c.Request().Header.Get("X-Active-Tenant"); h != "" {
				if requested, ok := parseIntHeader(h); ok && requested == claims.TenantID {
					activeTenantID = requested
				}
			}

			user := &shared.UserContext{
				UserID:           claims.UserID,
				TenantID:         claims.TenantID,
				Role:             claims.Role,
				Owner:            claims.Owner,
				UserType:         defaultString(claims.UserType, "STAFF"),
				Email:            claims.Email,
				Name:             claims.Name,
				JTI:              claims.JTI,
				Awaiting2FA:      claims.Awaiting2FA,
				ActiveTenantID:   activeTenantID,
				WellnessRole:     claims.WellnessRole,
				SubBrandAccess:   claims.SubBrandAccess,
			}

			ctx := shared.WithUser(c.Request().Context(), user)
			c.SetRequest(c.Request().WithContext(ctx))
			return next(c)
		}
	}
}

func isOpenPath(path string) bool {
	openPaths := []string{
		"/api/auth/login", "/api/auth/signup", "/api/auth/register",
		"/api/auth/customer/register", "/api/auth/email-otp", "/api/auth/check-email",
		"/api/auth/public/tenants", "/api/auth/forgot-password", "/api/auth/reset-password",
		"/api/auth/2fa/verify", "/api/health", "/api/status",
		"/api/marketplace-leads/webhook", "/api/sms/webhook", "/api/whatsapp/webhook",
		"/api/telephony/webhook", "/api/push/subscribe/visitor", "/api/push/vapid-key",
		"/api/communications/track/", "/api/sso/google/callback", "/api/sso/microsoft/callback",
		"/api/sso/google/start", "/api/sso/microsoft/start", "/api/email/inbound",
		"/api/calendar/google/callback", "/api/gmail/callback", "/api/calendar/outlook/callback",
		"/api/voice/webhook", "/api/portal/login", "/api/portal/register", "/api/portal/forgot",
		"/api/portal/reset", "/api/portal/me", "/api/portal/tickets", "/api/portal/invoices",
		"/api/portal/contracts", "/api/portal/travel", "/api/portal/kyc", "/api/signatures/sign",
		"/api/surveys/respond", "/api/surveys/public", "/api/chatbots/chat", "/api/web-visitors/track",
		"/api/payments/webhook", "/api/accounting/webhook", "/api/scim/v2", "/api/booking-pages/public",
		"/api/knowledge-base/public", "/api/live-chat/visitor", "/api/document-views/track",
		"/api/zapier/webhook", "/api/marketing/submit", "/api/v1/external", "/api/v1/voyagr",
		"/api/v1/flight-plugin", "/api/wellness/public", "/api/wellness/portal",
		"/api/attendance/biometric/webhook", "/api/travel/microsites/public", "/api/travel/diagnostics/public",
		"/api/travel/itineraries/public", "/api/travel/destination-photos/public",
		"/api/travel/reviews/public", "/api/travel/inbound/leads", "/api/travel/whatsapp/webhook",
		"/api/travel/whatsapp/media", "/api/v1/flyers/public", "/api/billing/public",
		"/api/csp/report", "/api/security/csp-report", "/api/privacy-policy",
		"/api/deleted-account-policy", "/api/terms-and-conditions", "/api/legal",
		"/api/landing-pages/public", "/api/landing-pages/wanderlux-static", "/api/brochure-assets",
		"/api/uploads/diagnostics/", "/api/pages/",
	}
	for _, p := range openPaths {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	if path == "/api-docs" || strings.HasPrefix(path, "/api-docs/") {
		return true
	}
	if path == "/" || path == "" {
		return true
	}
	return false
}

func extractToken(c echo.Context) (string, error) {
	authHeader := c.Request().Header.Get("Authorization")
	if authHeader != "" {
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			return parts[1], nil
		}
		return "", fmt.Errorf("Authentication required")
	}
	cookie, err := c.Cookie(authTokenCookie)
	if err == nil && cookie.Value != "" {
		return cookie.Value, nil
	}
	return "", fmt.Errorf("Authentication required")
}

func parseToken(tokenString, secret string) (*JWTClaims, error) {
	claims := &JWTClaims{}
	_, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if claims.TenantID == 0 {
		claims.TenantID = 1
	}
	if claims.UserType == "" {
		claims.UserType = "STAFF"
	}
	return claims, nil
}

func parseIntHeader(s string) (int, bool) {
	var v int
	_, err := fmt.Sscanf(s, "%d", &v)
	return v, err == nil
}

func defaultString(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// RequireRole returns middleware that requires one of the given roles.
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

// RequireStaff rejects portal/customer tokens.
func RequireStaff() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil || !u.IsStaff() {
				return shared.ErrForbidden(c)
			}
			return next(c)
		}
	}
}
