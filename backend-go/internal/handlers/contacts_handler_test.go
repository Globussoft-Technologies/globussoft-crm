package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

type mockContactService struct {
	list    func(ctx context.Context, tenantID int, p contacts.ListParams) ([]contacts.Contact, int, error)
	get     func(ctx context.Context, tenantID, id int, includeDeleted bool) (*contacts.Contact, error)
	create  func(ctx context.Context, userID, tenantID int, req contacts.CreateContactRequest) (*contacts.Contact, error)
	update  func(ctx context.Context, userID, tenantID, id int, req contacts.UpdateContactRequest) (*contacts.Contact, error)
	delete  func(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error)
	restore func(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error)
}

func (m *mockContactService) List(ctx context.Context, tenantID int, p contacts.ListParams) ([]contacts.Contact, int, error) {
	if m.list != nil {
		return m.list(ctx, tenantID, p)
	}
	return nil, 0, nil
}

func (m *mockContactService) GetByID(ctx context.Context, tenantID, id int, includeDeleted bool) (*contacts.Contact, error) {
	if m.get != nil {
		return m.get(ctx, tenantID, id, includeDeleted)
	}
	return nil, nil
}

func (m *mockContactService) Create(ctx context.Context, userID, tenantID int, req contacts.CreateContactRequest) (*contacts.Contact, error) {
	if m.create != nil {
		return m.create(ctx, userID, tenantID, req)
	}
	return nil, nil
}

func (m *mockContactService) Update(ctx context.Context, userID, tenantID, id int, req contacts.UpdateContactRequest) (*contacts.Contact, error) {
	if m.update != nil {
		return m.update(ctx, userID, tenantID, id, req)
	}
	return nil, nil
}

func (m *mockContactService) Delete(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error) {
	if m.delete != nil {
		return m.delete(ctx, userID, tenantID, id)
	}
	return nil, nil
}

func (m *mockContactService) Restore(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error) {
	if m.restore != nil {
		return m.restore(ctx, userID, tenantID, id)
	}
	return nil, nil
}

func userCtx(role string) *shared.UserContext {
	return &shared.UserContext{
		UserID:   1,
		TenantID: 1,
		Role:     role,
	}
}

func TestContactHandler_List(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/contacts?page=1&pageSize=10&search=acme&status=Lead", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		list: func(ctx context.Context, tenantID int, p contacts.ListParams) ([]contacts.Contact, int, error) {
			assert.Equal(t, 1, tenantID)
			assert.Equal(t, "acme", p.Search)
			assert.Equal(t, "Lead", p.Status)
			assert.Equal(t, 1, p.Page)
			assert.Equal(t, 10, p.PageSize)
			return []contacts.Contact{{ID: 1, Name: "Acme", Status: "Lead"}}, 1, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Acme")
	}
}

func TestContactHandler_Get(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/contacts/5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/contacts/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		get: func(ctx context.Context, tenantID, id int, includeDeleted bool) (*contacts.Contact, error) {
			assert.Equal(t, 5, id)
			return &contacts.Contact{ID: 5, Name: "Jane", Status: "Customer"}, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Get(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Jane")
	}
}

func TestContactHandler_Get_NotFound(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/contacts/99", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/contacts/:id")
	c.SetParamNames("id")
	c.SetParamValues("99")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		get: func(ctx context.Context, tenantID, id int, includeDeleted bool) (*contacts.Contact, error) {
			return nil, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Get(c)) {
		assert.Equal(t, http.StatusNotFound, rec.Code)
	}
}

func TestContactHandler_Create(t *testing.T) {
	e := echo.New()
	body := `{"name":"New Lead","email":"new@example.com","status":"Lead"}`
	req := httptest.NewRequest(http.MethodPost, "/api/contacts", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		create: func(ctx context.Context, userID, tenantID int, req contacts.CreateContactRequest) (*contacts.Contact, error) {
			assert.Equal(t, "New Lead", req.Name)
			assert.Equal(t, "new@example.com", *req.Email)
			return &contacts.Contact{ID: 7, Name: req.Name, Email: req.Email, Status: "Lead"}, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Create(c)) {
		assert.Equal(t, http.StatusCreated, rec.Code)
		assert.Contains(t, rec.Body.String(), "New Lead")
	}
}

func TestContactHandler_Create_ValidationError(t *testing.T) {
	e := echo.New()
	body := `{"name":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/contacts", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		create: func(ctx context.Context, userID, tenantID int, req contacts.CreateContactRequest) (*contacts.Contact, error) {
			return nil, services.ValidationError{Field: "name", Code: "NAME_REQUIRED", Message: "name is required"}
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Create(c)) {
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "NAME_REQUIRED")
	}
}

func TestContactHandler_Update(t *testing.T) {
	e := echo.New()
	body := `{"name":"Updated"}`
	req := httptest.NewRequest(http.MethodPut, "/api/contacts/5", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/contacts/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		update: func(ctx context.Context, userID, tenantID, id int, req contacts.UpdateContactRequest) (*contacts.Contact, error) {
			assert.Equal(t, 5, id)
			assert.Equal(t, "Updated", *req.Name)
			return &contacts.Contact{ID: 5, Name: "Updated", Status: "Lead"}, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Update(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "Updated")
	}
}

func TestContactHandler_Update_NotFound(t *testing.T) {
	e := echo.New()
	body := `{"name":"Updated"}`
	req := httptest.NewRequest(http.MethodPut, "/api/contacts/5", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/contacts/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		update: func(ctx context.Context, userID, tenantID, id int, req contacts.UpdateContactRequest) (*contacts.Contact, error) {
			return nil, sql.ErrNoRows
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Update(c)) {
		assert.Equal(t, http.StatusNotFound, rec.Code)
	}
}

func TestContactHandler_Delete(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/api/contacts/5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/contacts/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		delete: func(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error) {
			assert.Equal(t, 5, id)
			now := time.Now()
			return &contacts.Contact{ID: 5, Name: "Jane", DeletedAt: &now}, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Delete(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "softDeleted")
	}
}

func TestContactHandler_Restore(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/contacts/5/restore", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/contacts/:id/restore")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), userCtx("ADMIN"))))

	svc := &mockContactService{
		restore: func(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error) {
			assert.Equal(t, 5, id)
			return &contacts.Contact{ID: 5, Name: "Jane"}, nil
		},
	}
	h := NewContactHandler(svc)
	if assert.NoError(t, h.Restore(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "restored")
	}
}

func TestContactHandler_RequireUser(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/contacts", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewContactHandler(&mockContactService{})
	err := h.List(c)
	assert.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Body.String(), "UNAUTHORIZED")
}

var _ services.ContactService = (*mockContactService)(nil)
