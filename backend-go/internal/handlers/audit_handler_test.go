package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

type mockAuditService struct {
	logs  []repository.AuditLog
	ver   *repository.AuditVerifyResult
	list  func(ctx context.Context, tenantID int, entity, action string, limit int) ([]repository.AuditLog, error)
	check func(ctx context.Context, tenantID int) (*repository.AuditVerifyResult, error)
}

func (m *mockAuditService) List(ctx context.Context, tenantID int, entity, action string, limit int) ([]repository.AuditLog, error) {
	if m.list != nil {
		return m.list(ctx, tenantID, entity, action, limit)
	}
	return m.logs, nil
}

func (m *mockAuditService) Verify(ctx context.Context, tenantID int) (*repository.AuditVerifyResult, error) {
	if m.check != nil {
		return m.check(ctx, tenantID)
	}
	return m.ver, nil
}

func TestAuditHandler_List(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/audit?entity=Contact&action=CREATE", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), &shared.UserContext{
		UserID:   1,
		TenantID: 1,
		Role:     "ADMIN",
	})))

	svc := &mockAuditService{logs: []repository.AuditLog{
		{ID: 1, Action: "CREATE", Entity: "Contact", TenantID: 1, CreatedAt: time.Now()},
	}}
	h := NewAuditHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "CREATE")
	}
}

func TestAuditHandler_List_Forbidden(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/audit", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), &shared.UserContext{
		UserID:   1,
		TenantID: 1,
		Role:     "USER",
	})))

	svc := &mockAuditService{}
	h := NewAuditHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusForbidden, rec.Code)
	}
}

func TestAuditHandler_Verify(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/audit/verify", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), &shared.UserContext{
		UserID:   1,
		TenantID: 1,
		Role:     "ADMIN",
	})))

	svc := &mockAuditService{ver: &repository.AuditVerifyResult{
		TotalRows:         5,
		ChainLength:       5,
		IntegrityVerified: true,
	}}
	h := NewAuditHandler(svc)
	if assert.NoError(t, h.Verify(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "integrityVerified")
	}
}

var _ services.AuditService = (*mockAuditService)(nil)
