package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/marketplace"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/stretchr/testify/assert"
)

type mockMarketplaceRepo struct {
	listLeads            func(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error)
	getLeadByID          func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error)
	updateLeadStatus     func(ctx context.Context, id, tenantID int, status string) error
	updateLeadContactID  func(ctx context.Context, id, tenantID int, status string, contactID int) error
	findDuplicateContact func(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error)
	createDeal           func(ctx context.Context, d *marketplace.Deal) error
	getStats             func(ctx context.Context, tenantID int) (*marketplace.StatsResult, error)
	listConfigs          func(ctx context.Context, tenantID int) ([]marketplace.Config, error)
	getConfigByProvider  func(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error)
	createConfig         func(ctx context.Context, tenantID int, cfg *marketplace.Config) error
	updateConfig         func(ctx context.Context, tenantID int, cfg *marketplace.Config) error
}

func (m *mockMarketplaceRepo) ListLeads(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error) {
	if m.listLeads != nil {
		return m.listLeads(ctx, p)
	}
	return nil, 0, nil
}

func (m *mockMarketplaceRepo) GetLeadByID(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
	if m.getLeadByID != nil {
		return m.getLeadByID(ctx, id, tenantID)
	}
	return nil, nil
}

func (m *mockMarketplaceRepo) UpdateLeadStatus(ctx context.Context, id, tenantID int, status string) error {
	if m.updateLeadStatus != nil {
		return m.updateLeadStatus(ctx, id, tenantID, status)
	}
	return nil
}

func (m *mockMarketplaceRepo) UpdateLeadContactID(ctx context.Context, id, tenantID int, status string, contactID int) error {
	if m.updateLeadContactID != nil {
		return m.updateLeadContactID(ctx, id, tenantID, status, contactID)
	}
	return nil
}

func (m *mockMarketplaceRepo) FindDuplicateContact(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
	if m.findDuplicateContact != nil {
		return m.findDuplicateContact(ctx, tenantID, email, phone)
	}
	return nil, nil
}

func (m *mockMarketplaceRepo) CreateDeal(ctx context.Context, d *marketplace.Deal) error {
	if m.createDeal != nil {
		return m.createDeal(ctx, d)
	}
	return nil
}

func (m *mockMarketplaceRepo) GetStats(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
	if m.getStats != nil {
		return m.getStats(ctx, tenantID)
	}
	return &marketplace.StatsResult{}, nil
}

func (m *mockMarketplaceRepo) ListConfigs(ctx context.Context, tenantID int) ([]marketplace.Config, error) {
	if m.listConfigs != nil {
		return m.listConfigs(ctx, tenantID)
	}
	return nil, nil
}

func (m *mockMarketplaceRepo) GetConfigByProvider(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error) {
	if m.getConfigByProvider != nil {
		return m.getConfigByProvider(ctx, tenantID, provider)
	}
	return nil, nil
}

func (m *mockMarketplaceRepo) CreateConfig(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
	if m.createConfig != nil {
		return m.createConfig(ctx, tenantID, cfg)
	}
	return nil
}

func (m *mockMarketplaceRepo) UpdateConfig(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
	if m.updateConfig != nil {
		return m.updateConfig(ctx, tenantID, cfg)
	}
	return nil
}

func newMarketplaceSvc(repo repository.MarketplaceRepository, contact repository.ContactRepository) MarketplaceService {
	return NewMarketplaceService(repo, contact, noopExecer{})
}

func TestMarketplaceService_List_FullShape(t *testing.T) {
	repo := &mockMarketplaceRepo{
		listLeads: func(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error) {
			assert.Equal(t, 1, p.TenantID)
			assert.Equal(t, "indiamart", p.Provider)
			assert.Equal(t, "New", p.Status)
			assert.False(t, p.Summary)
			assert.Equal(t, 2, p.Page)
			assert.Equal(t, 25, p.Limit)
			return []marketplace.Lead{{ID: 1, Provider: "indiamart", Status: "New", TenantID: 1}}, 10, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	leads, total, page, pages, err := svc.List(context.Background(), 1, marketplace.ListParams{
		Provider: "indiamart", Status: "New", Page: 2, Limit: 25,
	})
	assert.NoError(t, err)
	assert.Equal(t, 10, total)
	assert.Equal(t, 2, page)
	assert.Equal(t, 1, pages)
	assert.IsType(t, []marketplace.Lead{}, leads)
}

func TestMarketplaceService_List_Summary(t *testing.T) {
	repo := &mockMarketplaceRepo{
		listLeads: func(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error) {
			assert.True(t, p.Summary)
			name := "Acme"
			return []marketplace.Lead{{ID: 1, Provider: "indiamart", Name: &name, Status: "New", TenantID: 1}}, 1, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	leads, _, _, _, err := svc.List(context.Background(), 1, marketplace.ListParams{Summary: true})
	assert.NoError(t, err)
	summary, ok := leads.([]marketplace.LeadSummary)
	assert.True(t, ok)
	assert.Len(t, summary, 1)
	assert.Equal(t, "Acme", *summary[0].Name)
}

func TestMarketplaceService_List_LimitClamped(t *testing.T) {
	repo := &mockMarketplaceRepo{
		listLeads: func(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error) {
			assert.Equal(t, marketplace.MaxLimit, p.Limit)
			return nil, 0, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	_, _, _, _, err := svc.List(context.Background(), 1, marketplace.ListParams{Limit: 9999})
	assert.NoError(t, err)
}

func TestMarketplaceService_Stats(t *testing.T) {
	repo := &mockMarketplaceRepo{
		getStats: func(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
			assert.Equal(t, 2, tenantID)
			return &marketplace.StatsResult{
				Total:    100,
				ThisWeek: 12,
				ByStatus: []marketplace.StatusCount{{Status: "Imported", Count: 30}},
			}, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	stats, err := svc.Stats(context.Background(), 2)
	assert.NoError(t, err)
	assert.Equal(t, 100, stats.Total)
	assert.Equal(t, 12, stats.ThisWeek)
	assert.Equal(t, 30.0, stats.ConversionRate)
}

func TestMarketplaceService_Stats_ZeroTotal(t *testing.T) {
	repo := &mockMarketplaceRepo{
		getStats: func(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
			return &marketplace.StatsResult{Total: 0}, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	stats, err := svc.Stats(context.Background(), 1)
	assert.NoError(t, err)
	assert.Equal(t, 0.0, stats.ConversionRate)
}

func TestMarketplaceService_Import_Success(t *testing.T) {
	name := "Raj"
	email := "raj@example.com"
	phone := "+91 12345"
	company := "Acme"
	product := "CRM"
	lead := &marketplace.Lead{ID: 7, Provider: "indiamart", Name: &name, Email: &email, Phone: &phone, Company: &company, Product: &product, Status: "New", TenantID: 1}

	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			assert.Equal(t, 7, id)
			return lead, nil
		},
		findDuplicateContact: func(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
			return nil, nil
		},
		createDeal: func(ctx context.Context, d *marketplace.Deal) error {
			assert.Equal(t, "CRM — Acme", d.Title)
			assert.Equal(t, 0.0, d.Amount)
			assert.Equal(t, "lead", d.Stage)
			assert.Equal(t, 42, d.ContactID)
			return nil
		},
		updateLeadContactID: func(ctx context.Context, id, tenantID int, status string, contactID int) error {
			assert.Equal(t, 7, id)
			assert.Equal(t, "Imported", status)
			assert.Equal(t, 42, contactID)
			return nil
		},
	}
	contactRepo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error {
			assert.Equal(t, "Raj", c.Name)
			assert.Equal(t, "raj@example.com", *c.Email)
			assert.Equal(t, "+91 12345", *c.Phone)
			assert.Equal(t, "Acme", *c.Company)
			assert.Equal(t, "Lead", c.Status)
			assert.Equal(t, "Indiamart", *c.Source)
			assert.Equal(t, 25, c.AIScore)
			c.ID = 42
			return nil
		},
	}

	svc := newMarketplaceSvc(repo, contactRepo)
	result, err := svc.Import(context.Background(), 1, 1, 7)
	assert.NoError(t, err)
	assert.True(t, result.Imported)
	assert.Equal(t, 42, *result.ContactID)
}

func TestMarketplaceService_Import_NoEmailGeneratesPlaceholder(t *testing.T) {
	name := "Raj"
	lead := &marketplace.Lead{ID: 9, Provider: "indiamart", Name: &name, Status: "New", TenantID: 1}

	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			return lead, nil
		},
		findDuplicateContact: func(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
			return nil, nil
		},
		createDeal:          func(ctx context.Context, d *marketplace.Deal) error { return nil },
		updateLeadContactID: func(ctx context.Context, id, tenantID int, status string, contactID int) error { return nil },
	}
	contactRepo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error {
			assert.Equal(t, "marketplace-indiamart-9@imported.local", *c.Email)
			c.ID = 55
			return nil
		},
	}

	svc := newMarketplaceSvc(repo, contactRepo)
	result, err := svc.Import(context.Background(), 1, 1, 9)
	assert.NoError(t, err)
	assert.True(t, result.Imported)
	assert.Equal(t, 55, *result.ContactID)
}

func TestMarketplaceService_Import_Duplicate(t *testing.T) {
	email := "dup@example.com"
	lead := &marketplace.Lead{ID: 10, Provider: "justdial", Email: &email, Status: "New", TenantID: 1}

	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			return lead, nil
		},
		findDuplicateContact: func(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
			return &marketplace.ContactSummary{ID: 20, Name: "Existing"}, nil
		},
		updateLeadContactID: func(ctx context.Context, id, tenantID int, status string, contactID int) error {
			assert.Equal(t, "Duplicate", status)
			assert.Equal(t, 20, contactID)
			return nil
		},
	}
	contactRepo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error {
			t.Fatal("should not create contact for duplicate")
			return nil
		},
	}

	svc := newMarketplaceSvc(repo, contactRepo)
	result, err := svc.Import(context.Background(), 1, 1, 10)
	assert.NoError(t, err)
	assert.False(t, result.Imported)
	assert.True(t, result.Duplicate)
	assert.Equal(t, 20, *result.ContactID)
	assert.Equal(t, "Duplicate contact found — lead linked.", result.Message)
}

func TestMarketplaceService_Import_AlreadyImported(t *testing.T) {
	lead := &marketplace.Lead{ID: 11, Provider: "indiamart", Status: "Imported", TenantID: 1}
	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			return lead, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	_, err := svc.Import(context.Background(), 1, 1, 11)
	assert.ErrorIs(t, err, ErrAlreadyImported)
}

func TestMarketplaceService_Import_NotFound(t *testing.T) {
	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			return nil, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	_, err := svc.Import(context.Background(), 1, 1, 99)
	assert.Equal(t, sql.ErrNoRows, err)
}

func TestMarketplaceService_ImportBulk(t *testing.T) {
	email1 := "a@example.com"
	email2 := "b@example.com"

	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			switch id {
			case 1:
				return &marketplace.Lead{ID: 1, Provider: "indiamart", Email: &email1, Status: "New", TenantID: 1}, nil
			case 2:
				return &marketplace.Lead{ID: 2, Provider: "indiamart", Email: &email2, Status: "New", TenantID: 1}, nil
			case 3:
				return &marketplace.Lead{ID: 3, Provider: "indiamart", Status: "Imported", TenantID: 1}, nil
			case 4:
				return nil, nil
			default:
				return nil, nil
			}
		},
		findDuplicateContact: func(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
			if email != nil && *email == "b@example.com" {
				return &marketplace.ContactSummary{ID: 200}, nil
			}
			return nil, nil
		},
		createDeal:          func(ctx context.Context, d *marketplace.Deal) error { return nil },
		updateLeadContactID: func(ctx context.Context, id, tenantID int, status string, contactID int) error { return nil },
	}

	contactID := 100
	contactRepo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error {
			contactID++
			c.ID = contactID
			return nil
		},
	}

	svc := newMarketplaceSvc(repo, contactRepo)
	result, err := svc.ImportBulk(context.Background(), 1, 1, []int{1, 2, 3, 4})
	assert.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 1, result.Duplicates)
	assert.Equal(t, 2, result.Failed)
}

func TestMarketplaceService_ImportBulk_Empty(t *testing.T) {
	svc := newMarketplaceSvc(&mockMarketplaceRepo{}, &mockContactRepo{})
	_, err := svc.ImportBulk(context.Background(), 1, 1, nil)
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "LEAD_IDS_REQUIRED", err.(ValidationError).Code)
}

func TestMarketplaceService_Dismiss_Success(t *testing.T) {
	lead := &marketplace.Lead{ID: 12, Provider: "indiamart", Status: "New", TenantID: 1}
	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			return lead, nil
		},
		updateLeadStatus: func(ctx context.Context, id, tenantID int, status string) error {
			assert.Equal(t, "Dismissed", status)
			return nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	result, err := svc.Dismiss(context.Background(), 1, 12)
	assert.NoError(t, err)
	assert.Equal(t, "Dismissed", result.Status)
}

func TestMarketplaceService_Dismiss_NotFound(t *testing.T) {
	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
			return nil, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	_, err := svc.Dismiss(context.Background(), 1, 99)
	assert.Equal(t, sql.ErrNoRows, err)
}

func TestMarketplaceService_ListConfigs_Masking(t *testing.T) {
	k1 := "sk-12345678"
	k2 := "short"
	k3 := "abc12345"
	repo := &mockMarketplaceRepo{
		listConfigs: func(ctx context.Context, tenantID int) ([]marketplace.Config, error) {
			return []marketplace.Config{
				{ID: 1, Provider: "indiamart", ApiKey: &k1, GlueCrmKey: &k2, TenantID: 1},
				{ID: 2, Provider: "justdial", ApiSecret: &k3, TenantID: 1},
			}, nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	configs, err := svc.ListConfigs(context.Background(), 1)
	assert.NoError(t, err)
	assert.Len(t, configs, 2)
	assert.Equal(t, "••••5678", *configs[0].ApiKey)
	assert.Equal(t, "••••hort", *configs[0].GlueCrmKey)
	assert.Nil(t, configs[0].ApiSecret)
	assert.Equal(t, "••••2345", *configs[1].ApiSecret)
}

func TestMarketplaceService_UpsertConfig_Create(t *testing.T) {
	apiKey := "key"
	isActive := true
	settings := map[string]any{"interval": "hourly"}
	repo := &mockMarketplaceRepo{
		getConfigByProvider: func(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error) {
			return nil, nil
		},
		createConfig: func(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
			assert.Equal(t, "indiamart", cfg.Provider)
			assert.Equal(t, "key", *cfg.ApiKey)
			assert.True(t, cfg.IsActive)
			assert.Equal(t, `{"interval":"hourly"}`, *cfg.Settings)
			return nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	result, err := svc.UpsertConfig(context.Background(), 1, "indiamart", marketplace.UpsertConfigRequest{
		ApiKey:   &apiKey,
		IsActive: &isActive,
		Settings: settings,
	})
	assert.NoError(t, err)
	assert.True(t, result.Success)
	assert.Equal(t, "indiamart", result.Provider)
	assert.True(t, result.IsActive)
}

func TestMarketplaceService_UpsertConfig_UpdatePreservesMaskedSecrets(t *testing.T) {
	existingKey := "secret-key"
	existingSecret := "secret-secret"
	existingGlue := "glue"
	masked := "••••-key"
	isActive := false

	repo := &mockMarketplaceRepo{
		getConfigByProvider: func(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error) {
			return &marketplace.Config{
				Provider:   "indiamart",
				ApiKey:     &existingKey,
				ApiSecret:  &existingSecret,
				GlueCrmKey: &existingGlue,
				IsActive:   true,
			}, nil
		},
		updateConfig: func(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
			assert.Equal(t, "secret-key", *cfg.ApiKey)
			assert.Equal(t, "secret-secret", *cfg.ApiSecret)
			assert.Equal(t, "glue", *cfg.GlueCrmKey)
			assert.False(t, cfg.IsActive)
			return nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	result, err := svc.UpsertConfig(context.Background(), 1, "indiamart", marketplace.UpsertConfigRequest{
		ApiKey:   &masked,
		IsActive: &isActive,
	})
	assert.NoError(t, err)
	assert.False(t, result.IsActive)
}

func TestMarketplaceService_UpsertConfig_UpdateSettingsString(t *testing.T) {
	settings := "{\"foo\":1}"
	repo := &mockMarketplaceRepo{
		getConfigByProvider: func(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error) {
			return &marketplace.Config{Provider: "indiamart"}, nil
		},
		updateConfig: func(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
			assert.Equal(t, "{\"foo\":1}", *cfg.Settings)
			return nil
		},
	}
	svc := newMarketplaceSvc(repo, &mockContactRepo{})
	_, err := svc.UpsertConfig(context.Background(), 1, "indiamart", marketplace.UpsertConfigRequest{Settings: settings})
	assert.NoError(t, err)
}

func TestMarketplaceService_ParseDateRange(t *testing.T) {
	from, err := ParseDateRange("2024-03-15", false)
	assert.NoError(t, err)
	assert.NotNil(t, from)
	assert.Equal(t, 2024, from.Year())
	assert.Equal(t, time.March, from.Month())
	assert.Equal(t, 15, from.Day())

	to, err := ParseDateRange("2024-03-15", true)
	assert.NoError(t, err)
	assert.Equal(t, 23, to.Hour())
	assert.Equal(t, 59, to.Minute())
	assert.Equal(t, 59, to.Second())

	rfc, err := ParseDateRange("2024-03-15T10:00:00Z", false)
	assert.NoError(t, err)
	assert.Equal(t, 10, rfc.UTC().Hour())

	empty, err := ParseDateRange("", false)
	assert.NoError(t, err)
	assert.Nil(t, empty)

	bad, err := ParseDateRange("not-a-date", false)
	assert.Error(t, err)
	assert.Nil(t, bad)
}

func TestMarketplaceService_MaskSecret(t *testing.T) {
	long := "12345678"
	masked := maskSecret(&long)
	assert.Equal(t, "••••5678", *masked)

	short := "ab"
	masked = maskSecret(&short)
	assert.Equal(t, "••••ab", *masked)

	assert.Nil(t, maskSecret(nil))

	empty := ""
	assert.Nil(t, maskSecret(&empty))
}

func TestMarketplaceService_BuildDealTitle(t *testing.T) {
	product := "Widget"
	company := "Globus"
	name := "User"
	lead := &marketplace.Lead{Product: &product, Company: &company, Name: &name}
	assert.Equal(t, "Widget — Globus", buildDealTitle(lead))

	lead2 := &marketplace.Lead{Name: &name}
	assert.Equal(t, "Inquiry — User", buildDealTitle(lead2))

	assert.Equal(t, "Inquiry — Unknown", buildDealTitle(&marketplace.Lead{}))
}

func TestMarketplaceService_BuildContactSource(t *testing.T) {
	lead := &marketplace.Lead{Provider: "justdial", Name: strPtr("A"), Email: strPtr("a@x.com")}
	contact := buildContactFromLead(lead, 1)
	assert.Equal(t, "Justdial", *contact.Source)
}

func strPtr(s string) *string { return &s }

func TestMarketplaceService_Import_AuditDetails(t *testing.T) {
	email := "x@example.com"
	lead := &marketplace.Lead{ID: 20, Provider: "indiamart", Email: &email, Status: "New", TenantID: 1}

	execer := &recordingExecer{}
	repo := &mockMarketplaceRepo{
		getLeadByID: func(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) { return lead, nil },
		findDuplicateContact: func(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
			return nil, nil
		},
		createDeal:          func(ctx context.Context, d *marketplace.Deal) error { return nil },
		updateLeadContactID: func(ctx context.Context, id, tenantID int, status string, contactID int) error { return nil },
	}
	contactRepo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error { c.ID = 88; return nil },
	}

	svc := NewMarketplaceService(repo, contactRepo, execer)
	_, err := svc.Import(context.Background(), 7, 1, 20)
	assert.NoError(t, err)
	assert.Contains(t, execer.lastQuery, "INSERT INTO AuditLog")

	details := map[string]any{}
	_ = json.Unmarshal([]byte(execer.lastArgs[3].(string)), &details)
	assert.Equal(t, 20.0, details["leadId"])
	assert.Equal(t, "Marketplace import (indiamart)", details["source"])
	assert.Equal(t, 88, execer.lastArgs[2]) // entityId
	assert.Equal(t, 1, execer.lastArgs[5])  // tenantId
	assert.Equal(t, 7, execer.lastArgs[6])  // userId
}

type recordingExecer struct {
	lastQuery string
	lastArgs  []any
}

func (r *recordingExecer) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	r.lastQuery = query
	r.lastArgs = args
	return nil, nil
}
