package shared

import (
	"encoding/json"
	"fmt"

	"github.com/microcosm-cc/bluemonday"
)

var htmlPolicy = bluemonday.UGCPolicy()

// SanitizeText strips HTML tags and dangerous attributes from a string.
// It mirrors backend/lib/sanitizeJson.js sanitizeText.
func SanitizeText(s string) string {
	return htmlPolicy.Sanitize(s)
}

// SanitizeJSON recursively sanitizes string values in an arbitrary JSON-compatible value.
func SanitizeJSON(value any) any {
	if value == nil {
		return nil
	}
	switch v := value.(type) {
	case string:
		return SanitizeText(v)
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, val := range v {
			out[k] = SanitizeJSON(val)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, val := range v {
			out[i] = SanitizeJSON(val)
		}
		return out
	default:
		return v
	}
}

// SanitizeJSONForStringColumn sanitizes a JSON-string column payload and returns a string.
// It preserves the shape so the stored string can be parsed back into the same structure.
func SanitizeJSONForStringColumn(input string) (string, error) {
	if input == "" {
		return "", nil
	}
	var value any
	if err := json.Unmarshal([]byte(input), &value); err != nil {
		return "", fmt.Errorf("invalid json column: %w", err)
	}
	cleaned := SanitizeJSON(value)
	out, err := json.Marshal(cleaned)
	if err != nil {
		return "", fmt.Errorf("failed to re-marshal sanitized json column: %w", err)
	}
	return string(out), nil
}

// SanitizeBody applies HTML sanitization to a JSON request body map.
// It is the middleware-level equivalent of backend/middleware/sanitizeBody.
func SanitizeBody(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = SanitizeJSON(v)
	}
	return out
}
