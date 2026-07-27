package shared

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

// APIError is the canonical JSON error envelope used by the Node.js backend.
// Almost every failure returns `{ error, code }` plus optional detail.
type APIError struct {
	Error  string `json:"error"`
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
	Path   string `json:"path,omitempty"`
	Method string `json:"method,omitempty"`
}

// ErrResponse sends a JSON error response and returns an Echo HTTPError so
// the caller can `return ErrResponse(...)` from a handler.
func ErrResponse(c echo.Context, status int, code, message string) error {
	return c.JSON(status, APIError{Error: message, Code: code})
}

// ErrResponseWithDetail sends a JSON error response with an extra detail field.
func ErrResponseWithDetail(c echo.Context, status int, code, message, detail string) error {
	return c.JSON(status, APIError{Error: message, Code: code, Detail: detail})
}

// ErrUnauthorized is a convenience helper for 401 UNAUTHORIZED responses.
func ErrUnauthorized(c echo.Context, message string) error {
	if message == "" {
		message = "Authentication required"
	}
	c.Response().Header().Set("WWW-Authenticate", "Bearer")
	return c.JSON(http.StatusUnauthorized, APIError{Error: message, Code: "UNAUTHORIZED"})
}

// ErrForbidden is a convenience helper for 403 RBAC_DENIED responses.
func ErrForbidden(c echo.Context) error {
	return c.JSON(http.StatusForbidden, APIError{
		Error: "You don't have permission to perform this action. Contact your administrator.",
		Code:  "RBAC_DENIED",
	})
}

// ErrNotFound is a convenience helper for 404 API_ROUTE_NOT_FOUND responses.
func ErrNotFound(c echo.Context) error {
	return c.JSON(http.StatusNotFound, APIError{
		Error:  "Endpoint not found",
		Code:   "API_ROUTE_NOT_FOUND",
		Path:   c.Request().URL.Path,
		Method: c.Request().Method,
	})
}

// ErrInternal is a convenience helper for 500 INTERNAL_ERROR responses.
func ErrInternal(c echo.Context, err error) error {
	return c.JSON(http.StatusInternalServerError, APIError{
		Error: "Internal server error",
		Code:  "INTERNAL_ERROR",
		Detail: err.Error(),
	})
}

// NewHTTPError creates a standard Echo HTTPError with a code.
func NewHTTPError(status int, code, message string) *echo.HTTPError {
	return echo.NewHTTPError(status, APIError{Error: message, Code: code})
}

// Common error code constants.
const (
	CodeUnauthorized        = "UNAUTHORIZED"
	CodeRBACDenied          = "RBAC_DENIED"
	CodeInternalError       = "INTERNAL_ERROR"
	CodeInvalidJSONBody     = "INVALID_JSON_BODY"
	CodePayloadTooLarge     = "PAYLOAD_TOO_LARGE"
	CodeRouteNotFound       = "API_ROUTE_NOT_FOUND"
	CodeValidationError     = "VALIDATION_ERROR"
	CodeTenantScopeMissing  = "TENANT_SCOPE_MISSING"
	CodeAuditListError      = "AUDIT_LIST_ERROR"
	CodeAuditVerifyError    = "AUDIT_VERIFY_ERROR"
	CodeAuditBackfillError  = "AUDIT_BACKFILL_ERROR"
	CodeHealthCheckError    = "HEALTH_CHECK_ERROR"
)
