package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

var dangerousFields = []string{
	"id", "userId", "tenantId", "createdAt", "updatedAt",
	"isAdmin", "passwordHash", "portalPasswordHash",
}

// StripDangerous removes forbidden keys from JSON request bodies before binding.
// It mirrors the Node.js stripDangerous middleware by re-reading the body,
// sanitizing the map, and restoring the body on the request.
func StripDangerous() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			req := c.Request()
			if req.Method == http.MethodGet || req.Method == http.MethodHead || req.Method == http.MethodDelete {
				return next(c)
			}
			contentType := req.Header.Get("Content-Type")
			if !strings.Contains(contentType, "application/json") {
				return next(c)
			}
			body, err := io.ReadAll(req.Body)
			if err != nil {
				return next(c)
			}
			_ = req.Body.Close()

			if len(body) > 0 {
				var m map[string]any
				if err := json.Unmarshal(body, &m); err == nil {
					stripDangerousMap(m)
					cleaned, _ := json.Marshal(m)
					req.Body = io.NopCloser(bytes.NewReader(cleaned))
				} else {
					req.Body = io.NopCloser(bytes.NewReader(body))
				}
			} else {
				req.Body = io.NopCloser(bytes.NewReader(body))
			}
			return next(c)
		}
	}
}

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
			for i, item := range arr {
				if child, ok := item.(map[string]any); ok {
					stripDangerousMap(child)
					arr[i] = child
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

// SanitizeBody applies HTML sanitization to JSON request bodies.
// It runs after StripDangerous and mirrors backend/middleware/sanitizeBody.
func SanitizeBody() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			req := c.Request()
			if req.Method == http.MethodGet || req.Method == http.MethodHead || req.Method == http.MethodDelete {
				return next(c)
			}
			contentType := req.Header.Get("Content-Type")
			if !strings.Contains(contentType, "application/json") {
				return next(c)
			}
			body, err := io.ReadAll(req.Body)
			if err != nil {
				return next(c)
			}
			_ = req.Body.Close()

			if len(body) > 0 {
				var m map[string]any
				if err := json.Unmarshal(body, &m); err == nil {
					cleaned := shared.SanitizeBody(m)
					out, _ := json.Marshal(cleaned)
					req.Body = io.NopCloser(bytes.NewReader(out))
				} else {
					req.Body = io.NopCloser(bytes.NewReader(body))
				}
			} else {
				req.Body = io.NopCloser(bytes.NewReader(body))
			}
			return next(c)
		}
	}
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

// scrubResponseWriter buffers the response body so it can be scrubbed before sending.
type scrubResponseWriter struct {
	http.ResponseWriter
	buf *bytes.Buffer
}

func (w *scrubResponseWriter) Write(b []byte) (int, error) {
	return w.buf.Write(b)
}

// ScrubResponseMiddleware scrubs sensitive fields from JSON responses before they are sent.
func ScrubResponseMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			original := c.Response().Writer
			sw := &scrubResponseWriter{ResponseWriter: original, buf: &bytes.Buffer{}}
			c.Response().Writer = sw

			err := next(c)

			c.Response().Writer = original
			contentType := c.Response().Header().Get(echo.HeaderContentType)
			body := sw.buf.Bytes()

			if err == nil && len(body) > 0 && (contentType == echo.MIMEApplicationJSON || contentType == echo.MIMEApplicationJSONCharsetUTF8) {
				var data any
				if json.Unmarshal(body, &data) == nil {
					scrubbed := ScrubResponse(data)
					if cleaned, err := json.Marshal(scrubbed); err == nil {
						body = cleaned
					}
				}
			}
			if len(body) > 0 {
				_, _ = original.Write(body)
			}
			return err
		}
	}
}
