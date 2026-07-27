package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/marketplace"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
)

// MarketplaceService defines the marketplace leads use-case interface.
type MarketplaceService interface {
	List(ctx context.Context, tenantID int, p marketplace.ListParams) (leads any, total, page, pages int, err error)
	Stats(ctx context.Context, tenantID int) (*marketplace.StatsResult, error)
	Import(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error)
	ImportBulk(ctx context.Context, userID, tenantID int, leadIDs []int) (*marketplace.BulkImportResult, error)
	Dismiss(ctx context.Context, tenantID, leadID int) (*marketplace.Lead, error)
	ListConfigs(ctx context.Context, tenantID int) ([]marketplace.Config, error)
	UpsertConfig(ctx context.Context, tenantID int, provider string, req marketplace.UpsertConfigRequest) (*marketplace.ConfigUpsertResult, error)
}

// ErrAlreadyImported is returned when a lead has already been imported.
var ErrAlreadyImported = errors.New("lead already imported")

type marketplaceSvc struct {
	repo    repository.MarketplaceRepository
	contact repository.ContactRepository
	db      shared.SQLExecer
}

// NewMarketplaceService returns a MarketplaceService.
func NewMarketplaceService(repo repository.MarketplaceRepository, contact repository.ContactRepository, db shared.SQLExecer) MarketplaceService {
	return &marketplaceSvc{repo: repo, contact: contact, db: db}
}

func (s *marketplaceSvc) List(ctx context.Context, tenantID int, p marketplace.ListParams) (any, int, int, int, error) {
	p.TenantID = tenantID
	if p.Page < 1 {
		p.Page = marketplace.DefaultPage
	}
	if p.Limit < 1 {
		p.Limit = marketplace.DefaultLimit
	}
	if p.Limit > marketplace.MaxLimit {
		p.Limit = marketplace.MaxLimit
	}

	leads, total, err := s.repo.ListLeads(ctx, p)
	if err != nil {
		return nil, 0, 0, 0, err
	}

	pages := int(math.Ceil(float64(total) / float64(p.Limit)))
	if p.Summary {
		return toLeadSummaries(leads), total, p.Page, pages, nil
	}
	return leads, total, p.Page, pages, nil
}

func toLeadSummaries(leads []marketplace.Lead) []marketplace.LeadSummary {
	result := make([]marketplace.LeadSummary, len(leads))
	for i, l := range leads {
		result[i] = marketplace.LeadSummary{
			ID:        l.ID,
			Provider:  l.Provider,
			Name:      l.Name,
			Status:    l.Status,
			ContactID: l.ContactID,
			CreatedAt: l.CreatedAt,
		}
	}
	return result
}

func (s *marketplaceSvc) Stats(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
	stats, err := s.repo.GetStats(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	imported := 0
	for _, sc := range stats.ByStatus {
		if sc.Status == marketplace.StatusImported {
			imported = sc.Count
			break
		}
	}

	if stats.Total > 0 {
		stats.ConversionRate = math.Round((float64(imported)/float64(stats.Total))*100*10) / 10
	} else {
		stats.ConversionRate = 0
	}
	return stats, nil
}

func (s *marketplaceSvc) Import(ctx context.Context, userID, tenantID, leadID int) (*marketplace.ImportResult, error) {
	lead, err := s.repo.GetLeadByID(ctx, leadID, tenantID)
	if err != nil {
		return nil, err
	}
	if lead == nil {
		return nil, sql.ErrNoRows
	}
	if lead.Status == marketplace.StatusImported {
		return nil, ErrAlreadyImported
	}

	existing, err := s.repo.FindDuplicateContact(ctx, tenantID, lead.Email, lead.Phone)
	if err != nil {
		return nil, fmt.Errorf("duplicate contact lookup: %w", err)
	}
	if existing != nil {
		if err := s.repo.UpdateLeadContactID(ctx, lead.ID, tenantID, marketplace.StatusDuplicate, existing.ID); err != nil {
			return nil, fmt.Errorf("link duplicate lead: %w", err)
		}
		return &marketplace.ImportResult{
			Imported:  false,
			Duplicate: true,
			ContactID: &existing.ID,
			Message:   "Duplicate contact found — lead linked.",
		}, nil
	}

	contact := buildContactFromLead(lead, tenantID)
	if err := s.contact.Create(ctx, contact); err != nil {
		return nil, fmt.Errorf("create contact from lead: %w", err)
	}

	deal := &marketplace.Deal{
		Title:     buildDealTitle(lead),
		Amount:    0,
		Stage:     "lead",
		ContactID: contact.ID,
		TenantID:  tenantID,
	}
	if err := s.repo.CreateDeal(ctx, deal); err != nil {
		return nil, fmt.Errorf("create deal from lead: %w", err)
	}

	if err := s.repo.UpdateLeadContactID(ctx, lead.ID, tenantID, marketplace.StatusImported, contact.ID); err != nil {
		return nil, fmt.Errorf("mark lead imported: %w", err)
	}

	details := map[string]any{
		"source": fmt.Sprintf("Marketplace import (%s)", lead.Provider),
		"leadId": lead.ID,
	}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Contact", "CREATE", contact.ID, userID, tenantID, string(detailsJSON))

	// TODO: emit marketplace_lead_imported (and deal_updated) socket event.

	return &marketplace.ImportResult{Imported: true, ContactID: &contact.ID}, nil
}

func (s *marketplaceSvc) ImportBulk(ctx context.Context, userID, tenantID int, leadIDs []int) (*marketplace.BulkImportResult, error) {
	if len(leadIDs) == 0 {
		return nil, ValidationError{Field: "leadIds", Code: "LEAD_IDS_REQUIRED", Message: "leadIds is required and must be a non-empty array"}
	}

	res := &marketplace.BulkImportResult{}
	for _, id := range leadIDs {
		result, err := s.Import(ctx, userID, tenantID, id)
		if err != nil {
			if errors.Is(err, ErrAlreadyImported) || err == sql.ErrNoRows {
				res.Failed++
				continue
			}
			res.Failed++
			continue
		}
		if result.Duplicate {
			res.Duplicates++
			continue
		}
		if result.Imported {
			res.Imported++
		}
	}

	// TODO: emit marketplace_lead_imported socket event with bulk summary.

	return res, nil
}

func (s *marketplaceSvc) Dismiss(ctx context.Context, tenantID, leadID int) (*marketplace.Lead, error) {
	lead, err := s.repo.GetLeadByID(ctx, leadID, tenantID)
	if err != nil {
		return nil, err
	}
	if lead == nil {
		return nil, sql.ErrNoRows
	}

	if err := s.repo.UpdateLeadStatus(ctx, lead.ID, tenantID, marketplace.StatusDismissed); err != nil {
		return nil, fmt.Errorf("dismiss lead: %w", err)
	}
	lead.Status = marketplace.StatusDismissed
	return lead, nil
}

func (s *marketplaceSvc) ListConfigs(ctx context.Context, tenantID int) ([]marketplace.Config, error) {
	configs, err := s.repo.ListConfigs(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for i := range configs {
		configs[i].ApiKey = maskSecret(configs[i].ApiKey)
		configs[i].ApiSecret = maskSecret(configs[i].ApiSecret)
		configs[i].GlueCrmKey = maskSecret(configs[i].GlueCrmKey)
	}
	return configs, nil
}

func maskSecret(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	v := *s
	if len(v) <= 4 {
		masked := "••••" + v
		return &masked
	}
	masked := "••••" + v[len(v)-4:]
	return &masked
}

func isMaskedSecret(s string) bool {
	return strings.HasPrefix(s, "••••")
}

func (s *marketplaceSvc) UpsertConfig(ctx context.Context, tenantID int, provider string, req marketplace.UpsertConfigRequest) (*marketplace.ConfigUpsertResult, error) {
	if strings.TrimSpace(provider) == "" {
		return nil, ValidationError{Field: "provider", Code: "PROVIDER_REQUIRED", Message: "provider is required"}
	}

	existing, err := s.repo.GetConfigByProvider(ctx, tenantID, provider)
	if err != nil {
		return nil, err
	}

	isActive := false
	if req.IsActive != nil {
		isActive = *req.IsActive
	} else if existing != nil {
		isActive = existing.IsActive
	}

	apiKey := resolveSecret(req.ApiKey, existing, func(c *marketplace.Config) *string { return c.ApiKey })
	apiSecret := resolveSecret(req.ApiSecret, existing, func(c *marketplace.Config) *string { return c.ApiSecret })
	glueCrmKey := resolveSecret(req.GlueCrmKey, existing, func(c *marketplace.Config) *string { return c.GlueCrmKey })

	settings := existingSettings(existing)
	if req.Settings != nil {
		settings = stringifySettings(req.Settings)
	}

	cfg := &marketplace.Config{
		Provider:   provider,
		ApiKey:     apiKey,
		ApiSecret:  apiSecret,
		GlueCrmKey: glueCrmKey,
		IsActive:   isActive,
		Settings:   settings,
	}

	if existing == nil {
		if err := s.repo.CreateConfig(ctx, tenantID, cfg); err != nil {
			return nil, fmt.Errorf("create marketplace config: %w", err)
		}
	} else {
		if err := s.repo.UpdateConfig(ctx, tenantID, cfg); err != nil {
			return nil, fmt.Errorf("update marketplace config: %w", err)
		}
	}

	return &marketplace.ConfigUpsertResult{
		Success:  true,
		Provider: provider,
		IsActive: isActive,
	}, nil
}

func resolveSecret(req *string, existing *marketplace.Config, getter func(*marketplace.Config) *string) *string {
	if req != nil && *req != "" && !isMaskedSecret(*req) {
		return req
	}
	if existing != nil {
		return getter(existing)
	}
	return nil
}

func existingSettings(existing *marketplace.Config) *string {
	if existing == nil {
		return nil
	}
	return existing.Settings
}

func stringifySettings(v any) *string {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		return &s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	s := string(b)
	return &s
}

func buildContactFromLead(lead *marketplace.Lead, tenantID int) *contacts.Contact {
	name := "Marketplace Lead"
	if lead.Name != nil && strings.TrimSpace(*lead.Name) != "" {
		name = strings.TrimSpace(*lead.Name)
	}
	email := fmt.Sprintf("marketplace-%s-%d@imported.local", lead.Provider, lead.ID)
	if lead.Email != nil && strings.TrimSpace(*lead.Email) != "" {
		email = strings.TrimSpace(*lead.Email)
	}
	status := "Lead"
	source := capitalize(lead.Provider)
	aiScore := 25

	contact := &contacts.Contact{
		Name:     name,
		Email:    &email,
		Status:   status,
		Source:   &source,
		AIScore:  aiScore,
		TenantID: tenantID,
	}
	if lead.Phone != nil && strings.TrimSpace(*lead.Phone) != "" {
		phone := strings.TrimSpace(*lead.Phone)
		contact.Phone = &phone
	}
	if lead.Company != nil && strings.TrimSpace(*lead.Company) != "" {
		company := strings.TrimSpace(*lead.Company)
		contact.Company = &company
	}
	return contact
}

func buildDealTitle(lead *marketplace.Lead) string {
	product := "Inquiry"
	if lead.Product != nil && strings.TrimSpace(*lead.Product) != "" {
		product = strings.TrimSpace(*lead.Product)
	}
	entity := "Unknown"
	if lead.Company != nil && strings.TrimSpace(*lead.Company) != "" {
		entity = strings.TrimSpace(*lead.Company)
	} else if lead.Name != nil && strings.TrimSpace(*lead.Name) != "" {
		entity = strings.TrimSpace(*lead.Name)
	}
	return fmt.Sprintf("%s — %s", product, entity)
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// ParseDateRange parses an ISO date/time string for a list filter.
// RFC3339 is used as-is; bare dates are anchored to the start or end of the day
// in Asia/Kolkata (the product timezone) to match the Node backend behaviour.
func ParseDateRange(raw string, isEnd bool) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
		if t, err := time.Parse(layout, raw); err == nil {
			return &t, nil
		}
	}
	t, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return nil, fmt.Errorf("invalid date: %w", err)
	}
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		return nil, err
	}
	if isEnd {
		t = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, loc)
	} else {
		t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	}
	return &t, nil
}

// Compile-time interface check.
var _ MarketplaceService = (*marketplaceSvc)(nil)
