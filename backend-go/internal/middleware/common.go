package middleware

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// RequestID adds a request ID header + context value for tracing.
func RequestID() echo.MiddlewareFunc {
	return middleware.RequestIDWithConfig(middleware.RequestIDConfig{
		Generator: func() string {
			return uuid.New().String()
		},
	})
}

// Logger returns Echo's structured logger middleware.
func Logger() echo.MiddlewareFunc {
	return middleware.LoggerWithConfig(middleware.LoggerConfig{
		Format: "{time_rfc3339} method=${method} uri=${uri} status=${status} latency=${latency_human} bytes_in=${bytes_in} bytes_out=${bytes_out}\n",
	})
}

// Recover returns Echo's recovery middleware with a JSON error body.
func Recover() echo.MiddlewareFunc {
	return middleware.RecoverWithConfig(middleware.RecoverConfig{
		LogErrorFunc: func(c echo.Context, err error, stack []byte) error {
			// Log via the framework logger; keep the response JSON.
			return nil
		},
	})
}

// BodyLimit enforces a maximum request body size.
func BodyLimit() echo.MiddlewareFunc {
	return middleware.BodyLimit("2M")
}

// Gzip enables gzip compression for responses.
func Gzip() echo.MiddlewareFunc {
	return middleware.GzipWithConfig(middleware.GzipConfig{
		Level: 5,
	})
}

// StripTrailingSlash standardizes paths.
func StripTrailingSlash() echo.MiddlewareFunc {
	return middleware.RemoveTrailingSlash()
}

// OpenPaths returns the raw list of open path prefixes for use by other layers.
func OpenPaths() []string {
	return []string{
		"/api/auth/", "/api/health", "/api/status", "/api/marketplace-leads/webhook",
		"/api/sms/webhook", "/api/whatsapp/webhook", "/api/telephony/webhook",
		"/api/push/", "/api/communications/track/", "/api/sso/", "/api/email/inbound",
		"/api/calendar/google/callback", "/api/gmail/callback", "/api/calendar/outlook/callback",
		"/api/voice/webhook", "/api/portal/", "/api/signatures/sign", "/api/surveys/",
		"/api/chatbots/chat", "/api/web-visitors/track", "/api/payments/webhook",
		"/api/accounting/webhook", "/api/scim/v2", "/api/booking-pages/public",
		"/api/knowledge-base/public", "/api/live-chat/visitor", "/api/document-views/track",
		"/api/zapier/webhook", "/api/marketing/submit", "/api/v1/external", "/api/v1/voyagr",
		"/api/v1/flight-plugin", "/api/wellness/public", "/api/wellness/portal",
		"/api/attendance/biometric/webhook", "/api/travel/microsites/public",
		"/api/travel/diagnostics/public", "/api/travel/itineraries/public",
		"/api/travel/destination-photos/public", "/api/travel/reviews/public",
		"/api/travel/inbound/leads", "/api/travel/whatsapp/webhook", "/api/travel/whatsapp/media",
		"/api/v1/flyers/public", "/api/billing/public", "/api/csp/report",
		"/api/security/csp-report", "/api/privacy-policy", "/api/deleted-account-policy",
		"/api/terms-and-conditions", "/api/legal", "/api/landing-pages/public",
		"/api/landing-pages/wanderlux-static", "/api/brochure-assets",
		"/api/uploads/diagnostics/", "/api/pages/", "/api-docs",
	}
}

// IsOpenPath checks if a path is in the open path list.
func IsOpenPath(path string) bool {
	for _, p := range OpenPaths() {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return path == "/" || path == ""
}

// HTTPErrorHandler returns a JSON error body for all Echo errors.
func HTTPErrorHandler(err error, c echo.Context) {
	if c.Response().Committed {
		return
	}
	var status int
	var code, message string
	switch e := err.(type) {
	case *echo.HTTPError:
		status = e.Code
		message = http.StatusText(e.Code)
		if msg, ok := e.Message.(string); ok && msg != "" {
			message = msg
		}
		code = "HTTP_" + http.StatusText(e.Code)
	default:
		status = http.StatusInternalServerError
		message = "Internal server error"
		code = "INTERNAL_ERROR"
	}
	if c.Response().Header().Get(echo.HeaderContentType) == "" {
		c.Response().Header().Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	}
	_ = c.JSON(status, map[string]any{"error": message, "code": code})
}
