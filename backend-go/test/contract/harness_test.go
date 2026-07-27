package contract

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRedact(t *testing.T) {
	input := map[string]any{
		"id":        123,
		"name":      "Alice",
		"createdAt": "2026-07-27T12:00:00Z",
		"nested": map[string]any{
			"passwordHash": "secret",
			"email":        "a@example.com",
		},
		"items": []any{
			map[string]any{"id": 1, "token": "x"},
		},
	}
	out := Redact(input, "id", "createdAt", "passwordHash", "token")
	m := out.(map[string]any)
	assert.Equal(t, "<redacted>", m["id"])
	assert.Equal(t, "Alice", m["name"])
	assert.Equal(t, "<redacted>", m["createdAt"])
	nested := m["nested"].(map[string]any)
	assert.Equal(t, "<redacted>", nested["passwordHash"])
	assert.Equal(t, "a@example.com", nested["email"])
	items := m["items"].([]any)
	assert.Equal(t, "<redacted>", items[0].(map[string]any)["id"])
	assert.Equal(t, "<redacted>", items[0].(map[string]any)["token"])
}

func TestCompare(t *testing.T) {
	a := map[string]any{"status": "ok"}
	b := map[string]any{"status": "ok"}
	assert.Empty(t, Compare(a, b))

	c := map[string]any{"status": "degraded"}
	assert.NotEmpty(t, Compare(a, c))
}
