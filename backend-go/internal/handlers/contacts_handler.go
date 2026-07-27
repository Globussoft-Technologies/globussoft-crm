package handlers

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

// ContactHandler implements /api/contacts endpoints.
type ContactHandler struct {
	svc services.ContactService
}

// NewContactHandler returns a ContactHandler.
func NewContactHandler(svc services.ContactService) *ContactHandler {
	return &ContactHandler{svc: svc}
}

// List handles GET /api/contacts.
func (h *ContactHandler) List(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	p := contacts.ListParams{
		TenantID:       u.TenantID,
		Search:         c.QueryParam("search"),
		Status:         c.QueryParam("status"),
		IncludeDeleted: c.QueryParam("includeDeleted") == "true",
		Page:           config.Atoi(c.QueryParam("page"), 1),
		PageSize:       config.Atoi(c.QueryParam("pageSize"), 20),
	}

	contactsList, total, err := h.svc.List(c.Request().Context(), u.TenantID, p)
	if err != nil {
		return shared.ErrInternal(c, err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"contacts": contactsList,
		"total":    total,
		"page":     p.Page,
		"pageSize": p.PageSize,
	})
}

// Get handles GET /api/contacts/:id.
func (h *ContactHandler) Get(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid contact ID")
	}

	includeDeleted := c.QueryParam("includeDeleted") == "true"
	contact, err := h.svc.GetByID(c.Request().Context(), u.TenantID, id, includeDeleted)
	if err != nil {
		return shared.ErrInternal(c, err)
	}
	if contact == nil {
		return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Contact not found")
	}
	return c.JSON(http.StatusOK, contact)
}

// Create handles POST /api/contacts.
func (h *ContactHandler) Create(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	var req contacts.CreateContactRequest
	if err := c.Bind(&req); err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeInvalidJSONBody, "Invalid JSON body")
	}

	contact, err := h.svc.Create(c.Request().Context(), u.UserID, u.TenantID, req)
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
	return c.JSON(http.StatusCreated, contact)
}

// Update handles PUT /api/contacts/:id.
func (h *ContactHandler) Update(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid contact ID")
	}

	var req contacts.UpdateContactRequest
	if err := c.Bind(&req); err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeInvalidJSONBody, "Invalid JSON body")
	}

	contact, err := h.svc.Update(c.Request().Context(), u.UserID, u.TenantID, id, req)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Contact not found")
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
	return c.JSON(http.StatusOK, contact)
}

// Delete handles DELETE /api/contacts/:id (soft delete).
func (h *ContactHandler) Delete(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid contact ID")
	}

	contact, err := h.svc.Delete(c.Request().Context(), u.UserID, u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Contact not found")
		}
		return shared.ErrInternal(c, err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"contact":     contact,
		"softDeleted": true,
	})
}

// Restore handles POST /api/contacts/:id/restore.
func (h *ContactHandler) Restore(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid contact ID")
	}

	contact, err := h.svc.Restore(c.Request().Context(), u.UserID, u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Contact not found")
		}
		return shared.ErrInternal(c, err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"contact":  contact,
		"restored": true,
	})
}
