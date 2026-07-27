package handlers

import (
	"net/http"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/labstack/echo/v4"
)

// HealthHandler implements /api/health and /api/status probes.
type HealthHandler struct {
	db *repository.DB
}

// NewHealthHandler returns a HealthHandler.
func NewHealthHandler(db *repository.DB) *HealthHandler {
	return &HealthHandler{db: db}
}

// Health responds to GET /api/health.
// Unauthenticated callers get a minimal {status, timestamp}; authenticated callers
// also see version, uptime, and database connectivity.
func (h *HealthHandler) Health(c echo.Context) error {
	ctx := c.Request().Context()
	status := "degraded"
	dbStatus := "disconnected"
	if h.db != nil {
		ok, err := h.db.Health(ctx)
		if ok {
			dbStatus = "connected"
			status = "healthy"
		} else {
			dbStatus = "error: " + err.Error()
		}
	}

	minimal := map[string]any{
		"status":    status,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	if c.Request().Header.Get("Authorization") == "" {
		return c.JSON(http.StatusOK, minimal)
	}
	return c.JSON(http.StatusOK, map[string]any{
		"status":   status,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"version":  config.AppVersion(),
		"uptime":   time.Since(serverStartTime).Seconds(),
		"database": dbStatus,
	})
}

// Root responds to GET /.
func (h *HealthHandler) Root(c echo.Context) error {
	if c.Request().Header.Get("Authorization") == "" {
		return c.JSON(http.StatusOK, map[string]any{"message": "Enterprise CRM API Core Online"})
	}
	return c.JSON(http.StatusOK, map[string]any{"message": "Enterprise CRM API Core Online", "version": config.AppVersion()})
}

// serverStartTime is set when the package is imported; used for uptime.
// It is overridden by the server bootstrap to the actual boot time.
var serverStartTime = time.Now()

// SetServerStartTime allows the server to set the real boot time.
func SetServerStartTime(t time.Time) {
	serverStartTime = t
}
