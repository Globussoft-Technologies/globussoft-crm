package handlers

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/marketplace"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

// MarketplaceHandler implements /api/marketplace-leads endpoints.
type MarketplaceHandler struct {
	svc services.MarketplaceService
}

// NewMarketplaceHandler returns a MarketplaceHandler.
func NewMarketplaceHandler(svc services.MarketplaceService) *MarketplaceHandler {
	return &MarketplaceHandler{svc: svc}
}

// List handles GET /api/marketplace-leads.
func (h *MarketplaceHandler) List(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	from, _ := services.ParseDateRange(c.QueryParam("from"), false)
	to, _ := services.ParseDateRange(c.QueryParam("to"), true)

	p := marketplace.ListParams{
		TenantID: u.TenantID,
		Provider: c.QueryParam("provider"),
		Status:   c.QueryParam("status"),
		From:     from,
		To:       to,
		Page:     config.Atoi(c.QueryParam("page"), marketplace.DefaultPage),
		Limit:    config.Atoi(c.QueryParam("limit"), marketplace.DefaultLimit),
		Summary:  c.QueryParam("fields") == "summary",
	}

	leads, total, page, pages, err := h.svc.List(c.Request().Context(), u.TenantID, p)
	if err != nil {
		return shared.ErrInternal(c, err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"leads": leads,
		"total": total,
		"page":  page,
		"pages": pages,
	})
}

// Stats handles GET /api/marketplace-leads/stats.
func (h *MarketplaceHandler) Stats(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	stats, err := h.svc.Stats(c.Request().Context(), u.TenantID)
	if err != nil {
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, stats)
}

// Import handles POST /api/marketplace-leads/import/:id.
func (h *MarketplaceHandler) Import(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid lead ID")
	}

	result, err := h.svc.Import(c.Request().Context(), u.UserID, u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Lead not found")
		}
		if errors.Is(err, services.ErrAlreadyImported) {
			return shared.ErrResponse(c, http.StatusBadRequest, "LEAD_ALREADY_IMPORTED", "Lead already imported.")
		}
		if ve, ok := err.(services.ValidationError); ok {
			return c.JSON(http.StatusBadRequest, map[string]any{
				"error": ve.Message,
				"code":  ve.Code,
				"field": ve.Field,
			})
		}
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

// ImportBulk handles POST /api/marketplace-leads/import-bulk.
func (h *MarketplaceHandler) ImportBulk(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	var req struct {
		LeadIDs []int `json:"leadIds"`
	}
	if err := c.Bind(&req); err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeInvalidJSONBody, "Invalid JSON body")
	}
	if len(req.LeadIDs) == 0 {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "No lead IDs provided.")
	}

	result, err := h.svc.ImportBulk(c.Request().Context(), u.UserID, u.TenantID, req.LeadIDs)
	if err != nil {
		if ve, ok := err.(services.ValidationError); ok {
			return c.JSON(http.StatusBadRequest, map[string]any{
				"error": ve.Message,
				"code":  ve.Code,
				"field": ve.Field,
			})
		}
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

// Dismiss handles PUT /api/marketplace-leads/dismiss/:id.
func (h *MarketplaceHandler) Dismiss(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid lead ID")
	}

	lead, err := h.svc.Dismiss(c.Request().Context(), u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Lead not found")
		}
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, lead)
}

// ListConfigs handles GET /api/marketplace-leads/config.
func (h *MarketplaceHandler) ListConfigs(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	configs, err := h.svc.ListConfigs(c.Request().Context(), u.TenantID)
	if err != nil {
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, configs)
}

// UpsertConfig handles PUT /api/marketplace-leads/config/:provider.
func (h *MarketplaceHandler) UpsertConfig(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	provider := strings.TrimSpace(c.Param("provider"))
	if provider == "" {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid provider")
	}

	var req marketplace.UpsertConfigRequest
	if err := c.Bind(&req); err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeInvalidJSONBody, "Invalid JSON body")
	}

	result, err := h.svc.UpsertConfig(c.Request().Context(), u.TenantID, provider, req)
	if err != nil {
		if ve, ok := err.(services.ValidationError); ok {
			return c.JSON(http.StatusBadRequest, map[string]any{
				"error": ve.Message,
				"code":  ve.Code,
				"field": ve.Field,
			})
		}
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

// Sync handles POST /api/marketplace-leads/sync/:provider.
func (h *MarketplaceHandler) Sync(c echo.Context) error {
	// TODO: port the Node marketplaceEngine cron; return 501 until then.
	return shared.ErrResponse(c, http.StatusNotImplemented, shared.CodeInternalError, "Manual marketplace sync is not yet implemented")
}

// WebhookIndiamart is a placeholder for the public IndiaMART webhook.
func (h *MarketplaceHandler) WebhookIndiamart(c echo.Context) error {
	// TODO: implement IndiaMART webhook ingestion and make this path public.
	return shared.ErrResponse(c, http.StatusNotImplemented, shared.CodeInternalError, "Marketplace webhook is not yet implemented")
}

// WebhookJustdial is a placeholder for the public JustDial webhook.
func (h *MarketplaceHandler) WebhookJustdial(c echo.Context) error {
	// TODO: implement JustDial webhook ingestion and make this path public.
	return shared.ErrResponse(c, http.StatusNotImplemented, shared.CodeInternalError, "Marketplace webhook is not yet implemented")
}

// WebhookTradeindia is a placeholder for the public TradeIndia webhook.
func (h *MarketplaceHandler) WebhookTradeindia(c echo.Context) error {
	// TODO: implement TradeIndia webhook ingestion and make this path public.
	return shared.ErrResponse(c, http.StatusNotImplemented, shared.CodeInternalError, "Marketplace webhook is not yet implemented")
}
