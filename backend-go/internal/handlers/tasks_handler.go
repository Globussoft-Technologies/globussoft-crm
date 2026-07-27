package handlers

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/tasks"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
)

// TaskHandler implements /api/tasks endpoints.
type TaskHandler struct {
	svc services.TaskService
}

// NewTaskHandler returns a TaskHandler.
func NewTaskHandler(svc services.TaskService) *TaskHandler {
	return &TaskHandler{svc: svc}
}

// taskDeleteResponse flattens a task and adds soft-delete operation flags.
type taskDeleteResponse struct {
	tasks.Task
	Idempotent  bool   `json:"idempotent,omitempty"`
	SoftDeleted bool   `json:"softDeleted"`
	Message     string `json:"message,omitempty"`
}

// taskRestoreResponse flattens a task and adds restore operation flags.
type taskRestoreResponse struct {
	tasks.Task
	Idempotent bool `json:"idempotent,omitempty"`
	Restored   bool `json:"restored"`
}

// List handles GET /api/tasks.
func (h *TaskHandler) List(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	p := tasks.ListParams{
		Status:         tasks.NormalizeStatusFilter(c.QueryParam("status")),
		Priority:       c.QueryParam("priority"),
		ContactID:      config.Atoi(c.QueryParam("contactId"), 0),
		Overdue:        c.QueryParam("overdue") == "true",
		Mine:           c.QueryParam("mine") == "true",
		IncludeDeleted: c.QueryParam("includeDeleted") == "true",
		Count:          c.QueryParam("count") == "1",
		Limit:          config.Atoi(c.QueryParam("limit"), 100),
		Offset:         config.Atoi(c.QueryParam("offset"), 0),
		Summary:        c.QueryParam("fields") == "summary",
		CallerUserID:   u.UserID,
		CallerRole:     u.Role,
	}

	tt, total, err := h.svc.List(c.Request().Context(), u.TenantID, p)
	if err != nil {
		return shared.ErrInternal(c, err)
	}

	if p.Count {
		return c.JSON(http.StatusOK, map[string]any{"total": total})
	}
	return c.JSON(http.StatusOK, tt)
}

// Create handles POST /api/tasks.
func (h *TaskHandler) Create(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}

	var req tasks.CreateTaskRequest
	if err := c.Bind(&req); err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeInvalidJSONBody, "Invalid JSON body")
	}

	task, err := h.svc.Create(c.Request().Context(), u.UserID, u.TenantID, req)
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
	return c.JSON(http.StatusCreated, task)
}

// Update handles PUT /api/tasks/:id.
func (h *TaskHandler) Update(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid task ID")
	}

	var req tasks.UpdateTaskRequest
	if err := c.Bind(&req); err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeInvalidJSONBody, "Invalid JSON body")
	}

	task, err := h.svc.Update(c.Request().Context(), u.UserID, u.TenantID, id, req)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Task not found")
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
	return c.JSON(http.StatusOK, task)
}

// Complete handles PUT /api/tasks/:id/complete.
func (h *TaskHandler) Complete(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid task ID")
	}

	task, _, err := h.svc.Complete(c.Request().Context(), u.UserID, u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Task not found")
		}
		return shared.ErrInternal(c, err)
	}
	return c.JSON(http.StatusOK, task)
}

// Delete handles DELETE /api/tasks/:id (soft delete).
func (h *TaskHandler) Delete(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid task ID")
	}

	task, idempotent, err := h.svc.Delete(c.Request().Context(), u.UserID, u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Task not found")
		}
		return shared.ErrInternal(c, err)
	}

	if idempotent {
		return c.JSON(http.StatusOK, taskDeleteResponse{Task: *task, Idempotent: true, SoftDeleted: true})
	}
	return c.JSON(http.StatusOK, taskDeleteResponse{Task: *task, SoftDeleted: true, Message: "Task soft-deleted"})
}

// Restore handles POST /api/tasks/:id/restore.
func (h *TaskHandler) Restore(c echo.Context) error {
	u, err := shared.RequireUser(c)
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return shared.ErrResponse(c, http.StatusBadRequest, shared.CodeValidationError, "Invalid task ID")
	}

	task, idempotent, err := h.svc.Restore(c.Request().Context(), u.UserID, u.TenantID, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return shared.ErrResponse(c, http.StatusNotFound, shared.CodeRouteNotFound, "Task not found")
		}
		return shared.ErrInternal(c, err)
	}

	if idempotent {
		return c.JSON(http.StatusOK, taskRestoreResponse{Task: *task, Idempotent: true, Restored: false})
	}
	return c.JSON(http.StatusOK, taskRestoreResponse{Task: *task, Restored: true})
}
