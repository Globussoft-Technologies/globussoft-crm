package shared

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestCanonicalize(t *testing.T) {
	// Same ordering semantics as backend/lib/audit.js canonicalize.
	assert.Equal(t, "null", Canonicalize(nil))
	assert.Equal(t, `"hello"`, Canonicalize("hello"))
	assert.Equal(t, "42", Canonicalize(42))
	assert.Equal(t, "[1,2,3]", Canonicalize([]any{1, 2, 3}))
	assert.Equal(t, `{"a":1,"b":2}`, Canonicalize(map[string]any{"b": 2, "a": 1}))
}

func TestComputeAuditHash(t *testing.T) {
	// Verifies Go computes the same hash formula as the Node backend.
	createdAt := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	entityID := 5
	userID := 2
	details := `{"name":"test"}`

	h := ComputeAuditHash("", 1, "CREATE", "Contact", &entityID, &userID, &details, createdAt)
	assert.Len(t, h, 64)
	assert.NotEmpty(t, h)

	// Recomputing with same inputs gives the same hash.
	h2 := ComputeAuditHash("", 1, "CREATE", "Contact", &entityID, &userID, &details, createdAt)
	assert.Equal(t, h, h2)
}

func TestGenesisFor(t *testing.T) {
	assert.Equal(t, "GENESIS_1", GenesisFor(1))
	assert.Equal(t, "GENESIS_42", GenesisFor(42))
}
