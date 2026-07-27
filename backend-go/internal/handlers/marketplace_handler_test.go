package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/marketplace"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

type mockMarketplaceService struct {
	list         func(ctx context.Context, tenantID int, p marketplace.ListParams) (any, int, int, int, error)
	stats        func(ctx context.Context, tenantID int) (*marketplace.StatsResult, error)
	importOne    func(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error)
	importBulk   func(ctx context.Context, userID, tenantID int, leadIDs []int) (*marketplace.BulkImportResult, error)
	dismiss      func(ctx context.Context, tenantID, leadID int) (*marketplace.Lead, error)
	listConfigs  func(ctx context.Context, tenantID int) ([]marketplace.Config, error)
	upsertConfig func(ctx context.Context, tenantID int, provider string, req marketplace.UpsertConfigRequest) (*marketplace.ConfigUpsertResult, error)
}

func (m *mockMarketplaceService) List(ctx context.Context, tenantID int, p marketplace.ListParams) (any, int, int, int, error) {
	if m.list != nil {
		return m.list(ctx, tenantID, p)
	}
	return nil, 0, 0, 0, nil
}

func (m *mockMarketplaceService) Stats(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
	if m.stats != nil {
		return m.stats(ctx, tenantID)
	}
	return &marketplace.StatsResult{}, nil
}

func (m *mockMarketplaceService) Import(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error) {
	if m.importOne != nil {
		return m.importOne(ctx, userID, tenantID, leadID)
	}
	return nil, nil
}

func (m *mockMarketplaceService) ImportBulk(ctx context.Context, userID, tenantID int, leadIDs []int) (*marketplace.BulkImportResult, error) {
	if m.importBulk != nil {
		return m.importBulk(ctx, userID, tenantID, leadIDs)
	}
	return nil, nil
}

func (m *mockMarketplaceService) Dismiss(ctx context.Context, tenantID, leadID int) (*marketplace.Lead, error) {
	if m.dismiss != nil {
		return m.dismiss(ctx, tenantID, leadID)
	}
	return nil, nil
}

func (m *mockMarketplaceService) ListConfigs(ctx context.Context, tenantID int) ([]marketplace.Config, error) {
	if m.listConfigs != nil {
		return m.listConfigs(ctx, tenantID)
	}
	return nil, nil
}

func (m *mockMarketplaceService) UpsertConfig(ctx context.Context, tenantID int, provider string, req marketplace.UpsertConfigRequest) (*marketplace.ConfigUpsertResult, error) {
	if m.upsertConfig != nil {
		return m.upsertConfig(ctx, tenantID, provider, req)
	}
	return nil, nil
}

func marketplaceUserCtx(role string) *shared.UserContext {
	return &shared.UserContext{UserID: 1, TenantID: 1, Role: role}
}

func TestMarketplaceHandler_List(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/marketplace-leads?provider=indiamart&status=New&page=2&limit=25&fields=summary&from=2024-01-01&to=2024-01-31", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		list: func(ctx context.Context, tenantID int, p marketplace.ListParams) (any, int, int, int, error) {
			assert.Equal(t, 1, tenantID)
			assert.Equal(t, "indiamart", p.Provider)
			assert.Equal(t, "New", p.Status)
			assert.True(t, p.Summary)
			assert.Equal(t, 2, p.Page)
			assert.Equal(t, 25, p.Limit)
			assert.NotNil(t, p.From)
			assert.NotNil(t, p.To)
			return []marketplace.LeadSummary{{ID: 1, Provider: "indiamart"}}, 10, 2, 1, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.List(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"total":10`)
	}
}

func TestMarketplaceHandler_Stats(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/marketplace-leads/stats", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		stats: func(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
			assert.Equal(t, 1, tenantID)
			return &marketplace.StatsResult{Total: 5, ThisWeek: 2, ConversionRate: 40.0}, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.Stats(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"conversionRate":40`)
	}
}

func TestMarketplaceHandler_Import(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/import/7", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/import/:id")
	c.SetParamNames("id")
	c.SetParamValues("7")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	contactID := 42
	svc := &mockMarketplaceService{
		importOne: func(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error) {
			assert.Equal(t, 7, leadID)
			return &marketplace.ImportResult{Imported: true, ContactID: &contactID}, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.Import(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"imported":true`)
	}
}

func TestMarketplaceHandler_Import_NotFound(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/import/99", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/import/:id")
	c.SetParamNames("id")
	c.SetParamValues("99")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		importOne: func(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error) {
			return nil, sql.ErrNoRows
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.Import(c)) {
		assert.Equal(t, http.StatusNotFound, rec.Code)
	}
}

func TestMarketplaceHandler_Import_AlreadyImported(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/import/5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/import/:id")
	c.SetParamNames("id")
	c.SetParamValues("5")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		importOne: func(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error) {
			return nil, services.ErrAlreadyImported
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.Import(c)) {
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "Lead already imported.")
	}
}

func TestMarketplaceHandler_Import_InvalidID(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/import/abc", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/import/:id")
	c.SetParamNames("id")
	c.SetParamValues("abc")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	h := NewMarketplaceHandler(&mockMarketplaceService{})
	if assert.NoError(t, h.Import(c)) {
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	}
}

func TestMarketplaceHandler_ImportBulk(t *testing.T) {
	e := echo.New()
	body := `{"leadIds":[1,2,3]}`
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/import-bulk", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		importBulk: func(ctx context.Context, userID, tenantID int, leadIDs []int) (*marketplace.BulkImportResult, error) {
			assert.Equal(t, []int{1, 2, 3}, leadIDs)
			return &marketplace.BulkImportResult{Imported: 2, Duplicates: 1, Failed: 0}, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.ImportBulk(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"duplicates":1`)
	}
}

func TestMarketplaceHandler_ImportBulk_Empty(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/import-bulk", strings.NewReader(`{"leadIds":[]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	h := NewMarketplaceHandler(&mockMarketplaceService{})
	if assert.NoError(t, h.ImportBulk(c)) {
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "No lead IDs provided.")
	}
}

func TestMarketplaceHandler_Dismiss(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPut, "/api/marketplace-leads/dismiss/8", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/dismiss/:id")
	c.SetParamNames("id")
	c.SetParamValues("8")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		dismiss: func(ctx context.Context, tenantID, leadID int) (*marketplace.Lead, error) {
			assert.Equal(t, 8, leadID)
			return &marketplace.Lead{ID: 8, Provider: "indiamart", Status: "Dismissed"}, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.Dismiss(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"status":"Dismissed"`)
	}
}

func TestMarketplaceHandler_Dismiss_NotFound(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPut, "/api/marketplace-leads/dismiss/8", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/dismiss/:id")
	c.SetParamNames("id")
	c.SetParamValues("8")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		dismiss: func(ctx context.Context, tenantID, leadID int) (*marketplace.Lead, error) {
			return nil, sql.ErrNoRows
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.Dismiss(c)) {
		assert.Equal(t, http.StatusNotFound, rec.Code)
	}
}

func TestMarketplaceHandler_ListConfigs(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/marketplace-leads/config", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	apiKey := "••••5678"
	svc := &mockMarketplaceService{
		listConfigs: func(ctx context.Context, tenantID int) ([]marketplace.Config, error) {
			assert.Equal(t, 1, tenantID)
			return []marketplace.Config{{ID: 1, Provider: "indiamart", ApiKey: &apiKey}}, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.ListConfigs(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "indiamart")
	}
}

func TestMarketplaceHandler_UpsertConfig(t *testing.T) {
	e := echo.New()
	body := `{"apiKey":"new-key","isActive":true,"settings":{"interval":"daily"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/marketplace-leads/config/indiamart", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/config/:provider")
	c.SetParamNames("provider")
	c.SetParamValues("indiamart")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	svc := &mockMarketplaceService{
		upsertConfig: func(ctx context.Context, tenantID int, provider string, req marketplace.UpsertConfigRequest) (*marketplace.ConfigUpsertResult, error) {
			assert.Equal(t, "indiamart", provider)
			assert.Equal(t, "new-key", *req.ApiKey)
			assert.True(t, *req.IsActive)
			settings, ok := req.Settings.(map[string]any)
			assert.True(t, ok)
			assert.Equal(t, "daily", settings["interval"])
			return &marketplace.ConfigUpsertResult{Success: true, Provider: "indiamart", IsActive: true}, nil
		},
	}
	h := NewMarketplaceHandler(svc)
	if assert.NoError(t, h.UpsertConfig(c)) {
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), `"success":true`)
	}
}

func TestMarketplaceHandler_UpsertConfig_InvalidProvider(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPut, "/api/marketplace-leads/config/", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/config/:provider")
	c.SetParamNames("provider")
	c.SetParamValues("   ")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	h := NewMarketplaceHandler(&mockMarketplaceService{})
	if assert.NoError(t, h.UpsertConfig(c)) {
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	}
}

func TestMarketplaceHandler_Sync(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/sync/indiamart", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPath("/api/marketplace-leads/sync/:provider")
	c.SetParamNames("provider")
	c.SetParamValues("indiamart")
	c.SetRequest(c.Request().WithContext(shared.WithUser(c.Request().Context(), marketplaceUserCtx("ADMIN"))))

	h := NewMarketplaceHandler(&mockMarketplaceService{})
	if assert.NoError(t, h.Sync(c)) {
		assert.Equal(t, http.StatusNotImplemented, rec.Code)
	}
}

func TestMarketplaceHandler_WebhookIndiamart(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/marketplace-leads/webhook/indiamart", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewMarketplaceHandler(&mockMarketplaceService{})
	if assert.NoError(t, h.WebhookIndiamart(c)) {
		assert.Equal(t, http.StatusNotImplemented, rec.Code)
	}
}

func TestMarketplaceHandler_RequireUser(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/marketplace-leads", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewMarketplaceHandler(&mockMarketplaceService{})
	err := h.List(c)
	assert.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

var _ services.MarketplaceService = (*mockMarketplaceService)(nil)
