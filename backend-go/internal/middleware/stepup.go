package middleware

import (
	"fmt"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
)

// StepUpClaims represents the step-up JWT payload.
type StepUpClaims struct {
	UserID   int    `json:"userId"`
	TenantID int    `json:"tenantId"`
	Method   string `json:"method"`
	Kind     string `json:"kind"`
	jwt.RegisteredClaims
}

// StepUpConfig configures step-up token verification.
type StepUpConfig struct {
	JWTSecret string
	Timeout   time.Duration
}

// StepUp returns middleware that requires a valid step-up token for destructive operations.
func StepUp(cfg StepUpConfig) echo.MiddlewareFunc {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Minute
	}
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u := shared.UserFromEcho(c)
			if u == nil {
				return c.JSON(401, shared.APIError{Error: "Authentication required before step-up check.", Code: "STEP_UP_REQUIRED"})
			}
			token := c.Request().Header.Get("X-Step-Up-Token")
			if token == "" {
				var body struct{ StepUpToken string `json:"stepUpToken"` }
				if err := c.Bind(&body); err == nil {
					token = body.StepUpToken
				}
			}
			if token == "" {
				return c.JSON(401, shared.APIError{Error: "Step-up authentication required. Re-confirm your password or TOTP code.", Code: "STEP_UP_REQUIRED"})
			}
			claims := &StepUpClaims{}
			_, err := jwt.ParseWithClaims(token, claims, func(token *jwt.Token) (any, error) {
				if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
				}
				return []byte(cfg.JWTSecret), nil
			})
			if err != nil {
				if err == jwt.ErrTokenExpired {
					return c.JSON(401, shared.APIError{Error: "Step-up confirmation expired. Re-confirm to proceed.", Code: "STEP_UP_EXPIRED"})
				}
				return c.JSON(401, shared.APIError{Error: "Invalid step-up token.", Code: "STEP_UP_INVALID"})
			}
			if claims.Kind != "step-up" {
				return c.JSON(401, shared.APIError{Error: "Token is not a step-up confirmation token.", Code: "STEP_UP_INVALID"})
			}
			if claims.UserID != u.UserID {
				return c.JSON(401, shared.APIError{Error: "Step-up token does not match the current user.", Code: "STEP_UP_USER_MISMATCH"})
			}
			if claims.TenantID != u.TenantID {
				return c.JSON(401, shared.APIError{Error: "Step-up token tenant mismatch.", Code: "STEP_UP_USER_MISMATCH"})
			}
			if claims.IssuedAt != nil && time.Since(claims.IssuedAt.Time) > cfg.Timeout {
				return c.JSON(401, shared.APIError{Error: "Step-up confirmation expired. Re-confirm to proceed.", Code: "STEP_UP_EXPIRED"})
			}
			c.Set("stepUp", map[string]any{
				"method": claims.Method,
				"iat":    claims.IssuedAt,
			})
			return next(c)
		}
	}
}
