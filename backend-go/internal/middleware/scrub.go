package middleware

import (
	"strings"

	"github.com/labstack/echo/v4"
)

var dangerousFields = []string{
	"id", "userId", "tenantId", "createdAt", "updatedAt",
	"isAdmin", "passwordHash", "portalPasswordHash",
}

// StripDangerous removes forbidden keys from JSON request bodies before binding.
// It mirrors the Node.js stripDangerous middleware.
func StripDangerous() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Echo's JSON binding does not expose a mutable map before bind.
			// For Phase 0, this middleware is a no-op placeholder; handlers that
			// read raw JSON bodies should strip these keys explicitly until a
			// body-mapper middleware is added.
			return next(c)
		}
	}
}

// stripDangerousMap recursively removes forbidden keys from a map.
func stripDangerousMap(m map[string]any) {
	for k, v := range m {
		if isDangerous(k) {
			delete(m, k)
			continue
		}
		if child, ok := v.(map[string]any); ok {
			stripDangerousMap(child)
		}
		if arr, ok := v.([]any); ok {
			for _, item := range arr {
				if child, ok := item.(map[string]any); ok {
					stripDangerousMap(child)
				}
			}
		}
	}
}

func isDangerous(key string) bool {
	for _, f := range dangerousFields {
		if strings.EqualFold(key, f) {
			return true
		}
	}
	return false
}

// ScrubResponse recursively removes password hashes and isAdmin from response maps.
func ScrubResponse(data any) any {
	if data == nil {
		return nil
	}
	switch v := data.(type) {
	case map[string]any:
		scrubbed := make(map[string]any, len(v))
		for k, val := range v {
			if isDangerous(k) {
				continue
			}
			scrubbed[k] = ScrubResponse(val)
		}
		return scrubbed
	case []any:
		out := make([]any, len(v))
		for i, val := range v {
			out[i] = ScrubResponse(val)
		}
		return out
	default:
		return v
	}
}

// ScrubResponseMiddleware wraps Echo responses and scrubs sensitive fields.
func ScrubResponseMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Phase 0: rely on handlers to return scrubbed data. A full response-map
			// wrapper is added in Phase 1.
			return next(c)
		}
	}
}
