package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/tasks"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

type mockTaskService struct {
	list     func(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error)
	create   func(ctx context.Context, userID, tenantID int, req tasks.CreateTaskRequest) (*tasks.Task, error)
	update   func(ctx context.Context, userID, tenantID, id int, req tasks.UpdateTaskRequest) (*tasks.Task, error)
	complete func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error)
	delete   func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error)
	restore  func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error)
}

func (m *mockTaskService) List(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error) {
	if m.list != nil {
		return m.list(ctx, tenantID, p)
	}
	return nil, 0, nil
}

func (m *mockTaskService) Create(ctx context.Context, userID, tenantID int, req tasks.CreateTaskRequest) (*tasks.Task, error) {
	if m.create != nil {
		return m.create(ctx, userID, tenantID, req)
	}
	return nil, nil
}

func (m *mockTaskService) Update(ctx context.Context, userID, tenantID, id int, req tasks.UpdateTaskRequest) (*tasks.Task, error) {
	if m.update != nil {
		return m.update(ctx, userID, tenantID, id, req)
	}
	return nil, nil
}

func (m *mockTaskService) Complete(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
	if m.complete != nil {
		return m.complete(ctx, userID, tenantID, id)
	}
	return nil, false, nil
}

func (m *mockTaskService) Delete(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
	if m.delete != nil {
		return m.delete(ctx, userID, tenantID, id)
	}
	return nil, false, nil
}

func (m *mockTaskService) Restore(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
	if m.restore != nil {
		return m.restore(ctx, userID, tenantID, id)
	}
	return nil, false, nil
}

func taskUserCtx(role string) *shared.UserContext {
	return &shared.UserContext{
		UserID:   1,
		TenantID: 1,
		Role:     role,
	}
}

func TestTaskHandler_List(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks?status=PENDING&priority=High&contactId=10&overdue=true&mine=true&limit=50&offset=10", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		list: func(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error) {
			assert.Equal(t, 1, tenantID)
			assert.Equal(t, "Pending", p.Status)
			assert.Equal(t, "High", p.Priority)
			assert.Equal(t, 10, p.ContactID)
			assert.True(t, p.Overdue)
			assert.True(t, p.Mine)
			assert.Equal(t, 50, p.Limit)
			assert.Equal(t, 10, p.Offset)
			assert.Equal(t, 1, p.CallerUserID)
			assert.Equal(t, "ADMIN", p.CallerRole)
			return []tasks.Task{{ID: 1, Title: "Call"}}, 1, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Call")
	}
}

func TestTaskHandler_List_Count(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks?count=1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		list: func(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error) {
			assert.True(t, p.Count)
			return nil, 7, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"total":7`)
	}
}

func TestTaskHandler_List_Summary(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks?fields=summary", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		list: func(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error) {
			assert.True(t, p.Summary)
			return []tasks.Task{{ID: 1, Title: "Call"}}, 1, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
	}
}

func TestTaskHandler_Create(t *testing.T) {
	e := echo.New()
	body := `{"title":"Call lead","dueDate":"2026-07-27T10:00","contactId":9,"targetUserId":5,"priority":"High"}`
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		create: func(ctx context.Context, userID, tenantID int, req tasks.CreateTaskRequest) (*tasks.Task, error) {
			assert.Equal(t, "Call lead", req.Title)
			assert.Equal(t, 9, req.ContactID)
			assert.Equal(t, 5, req.TargetUserID)
			assert.Equal(t, "High", req.Priority)
			return &tasks.Task{ID: 7, Title: req.Title, Priority: req.Priority}, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Create(c)) {
		assert.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), "Call lead")
	}
}

func TestTaskHandler_Create_ValidationError(t *testing.T) {
	e := echo.New()
	body := `{"title":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		create: func(ctx context.Context, userID, tenantID int, req tasks.CreateTaskRequest) (*tasks.Task, error) {
			return nil, services.ValidationError{Field: "title", Code: "TITLE_REQUIRED", Message: "title is required"}
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Create(c)) {
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "TITLE_REQUIRED")
	}
}

func TestTaskHandler_Update(t *testing.T) {
	e := echo.New()
	body := `{"title":"Updated"}`
	req := httptest.NewRequest(http.MethodPut, "/api/tasks/5", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		update: func(ctx context.Context, userID, tenantID, id int, req tasks.UpdateTaskRequest) (*tasks.Task, error) {
			assert.Equal(t, 5, id)
			assert.Equal(t, "Updated", *req.Title)
			return &tasks.Task{ID: 5, Title: "Updated", Priority: "Medium"}, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Update(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Updated")
	}
}

func TestTaskHandler_Update_NotFound(t *testing.T) {
	e := echo.New()
	body := `{"title":"Updated"}`
	req := httptest.NewRequest(http.MethodPut, "/api/tasks/5", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		update: func(ctx context.Context, userID, tenantID, id int, req tasks.UpdateTaskRequest) (*tasks.Task, error) {
			return nil, sql.ErrNoRows
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Update(c)) {
		assert.Equal(t, http.StatusNotFound, rec.Code)
	}
}

func TestTaskHandler_Complete(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPut, "/api/tasks/5/complete", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id/complete")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		complete: func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
			assert.Equal(t, 5, id)
			return &tasks.Task{ID: 5, Title: "Done", Status: "Completed"}, false, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Complete(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Completed")
	}
}

func TestTaskHandler_Delete(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/api/tasks/5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		delete: func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
			assert.Equal(t, 5, id)
			now := time.Now()
			return &tasks.Task{ID: 5, Title: "T", DeletedAt: &now}, false, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Delete(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "softDeleted")
	}
}

func TestTaskHandler_Delete_Idempotent(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/api/tasks/5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		delete: func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
			now := time.Now()
			return &tasks.Task{ID: 5, Title: "T", DeletedAt: &now}, true, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Delete(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "idempotent")
		assert.Contains(t, rec.Body.String(), "softDeleted")
	}
}

func TestTaskHandler_Restore(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/tasks/5/restore", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id/restore")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		restore: func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
			assert.Equal(t, 5, id)
			return &tasks.Task{ID: 5, Title: "T"}, false, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Restore(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "restored")
	}
}

func TestTaskHandler_Restore_Idempotent(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/tasks/5/restore", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/tasks/:id/restore")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), taskUserCtx("ADMIN"))))

	svc := &mockTaskService{
		restore: func(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
			return &tasks.Task{ID: 5, Title: "T"}, true, nil
		},
	}
	h := NewTaskHandler(svc)
	if assert.NoError(t, h.Restore(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "idempotent")
		assert.Contains(t, rec.Body.String(), `"restored":false`)
	}
}

func TestTaskHandler_RequireUser(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewTaskHandler(&mockTaskService{})
	err := h.List(c)
	assert.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

var _ services.TaskService = (*mockTaskService)(nil)
