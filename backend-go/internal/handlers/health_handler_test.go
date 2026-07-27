package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

func TestHealthHandler_Health_Unauthenticated(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewHealthHandler(nil)
	if assert.NoError(t, h.Health(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "status")
		assert.Contains(t, rec.Body.String(), "timestamp")
		assert.NotContains(t, rec.Body.String(), "version")
	}
}

func TestHealthHandler_Health_Authenticated(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewHealthHandler(nil)
	if assert.NoError(t, h.Health(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "version")
	}
}

func TestHealthHandler_Root(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewHealthHandler(nil)
	if assert.NoError(t, h.Root(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Enterprise CRM API Core Online")
	}
}

func TestHealthHandler_Health_WithDB(t *testing.T) {
	// This test requires a real DATABASE_URL; skipped in CI without one.
	db, err := repository.NewDB("root:local_dev_pw@tcp(localhost:3307)/gbscrm_local?parseTime=true")
	if err != nil {
		t.Skipf("database not available: %v", err)
	}
	defer db.Close()

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewHealthHandler(db)
	if assert.NoError(t, h.Health(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "healthy")
	}
}
