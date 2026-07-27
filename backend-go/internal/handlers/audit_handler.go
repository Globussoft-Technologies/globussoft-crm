package handlers

import (
	"net/http"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

// AuditHandler implements GET /api/audit and /api/audit/verify.
type AuditHandler struct {
	svc services.AuditService
}

// NewAuditHandler returns an AuditHandler.
func NewAuditHandler(svc services.AuditService) *AuditHandler {
	return &AuditHandler{svc: svc}
}

// List handles GET /api/audit.
func (h *AuditHandler) List(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	if !u.IsAdmin() {
		return shared.ErrForbidden(c)
	}

	entity := c.QueryParam("entity")
	action := c.QueryParam("action")
	limit := config.Atoi(c.QueryParam("limit"), 100)

	logs, err := h.svc.List(c.Request().Context(), u.TenantID, entity, action, limit)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, shared.APIError{Error: "Failed to fetch audit logs", Code: shared.CodeAuditListError})
	}
	return c.JSON(http.StatusOK, logs)
}

// Verify handles GET /api/audit/verify.
func (h *AuditHandler) Verify(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	if !u.IsAdmin() {
		return shared.ErrForbidden(c)
	}

	res, err := h.svc.Verify(c.Request().Context(), u.TenantID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, shared.APIError{Error: "Failed to verify audit chain", Code: shared.CodeAuditVerifyError})
	}
	return c.JSON(http.StatusOK, res)
}
