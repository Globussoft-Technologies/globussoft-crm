package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/marketplace"
)

// MarketplaceRepository defines data access for marketplace leads and configs.
type MarketplaceRepository interface {
	ListLeads(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error)
	GetLeadByID(ctx context.Context, id, tenantID int) (*marketplace.Lead, error)
	UpdateLeadStatus(ctx context.Context, id, tenantID int, status string) error
	UpdateLeadContactID(ctx context.Context, id, tenantID int, status string, contactID int) error
	FindDuplicateContact(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error)
	CreateDeal(ctx context.Context, d *marketplace.Deal) error

	GetStats(ctx context.Context, tenantID int) (*marketplace.StatsResult, error)

	ListConfigs(ctx context.Context, tenantID int) ([]marketplace.Config, error)
	GetConfigByProvider(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error)
	CreateConfig(ctx context.Context, tenantID int, cfg *marketplace.Config) error
	UpdateConfig(ctx context.Context, tenantID int, cfg *marketplace.Config) error
}

type marketplaceRepo struct {
	db *DB
}

// NewMarketplaceRepository returns a MarketplaceRepository backed by database/sql.
func NewMarketplaceRepository(db *DB) MarketplaceRepository {
	return &marketplaceRepo{db: db}
}

const leadColumnsFull = `
	ml.id, ml.provider, ml.externalLeadId, ml.rawPayload, ml.name, ml.email, ml.phone, ml.company,
	ml.product, ml.message, ml.city, ml.status, ml.contactId, ml.createdAt, ml.tenantId,
	c.id AS contactId2, c.name AS contactName, c.email AS contactEmail
`

const leadColumnsSummary = `
	ml.id, ml.provider, ml.name, ml.status, ml.contactId, ml.createdAt
`

func (r *marketplaceRepo) ListLeads(ctx context.Context, p marketplace.ListParams) ([]marketplace.Lead, int, error) {
	where, args := r.buildWhere(p)
	whereSQL := strings.Join(where, " AND ")

	var total int
	countQuery := "SELECT COUNT(*) FROM MarketplaceLead ml WHERE " + whereSQL
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("marketplace lead count query: %w", err)
	}

	page := p.Page
	if page < 1 {
		page = 1
	}
	limit := p.Limit
	if limit < 1 {
		limit = marketplace.DefaultLimit
	}
	if limit > marketplace.MaxLimit {
		limit = marketplace.MaxLimit
	}
	offset := (page - 1) * limit

	var query string
	if p.Summary {
		query = fmt.Sprintf(`
			SELECT %s
			FROM MarketplaceLead ml
			WHERE %s
			ORDER BY ml.createdAt DESC
			LIMIT ? OFFSET ?`, leadColumnsSummary, whereSQL)
	} else {
		query = fmt.Sprintf(`
			SELECT %s
			FROM MarketplaceLead ml
			LEFT JOIN Contact c ON c.id = ml.contactId
			WHERE %s
			ORDER BY ml.createdAt DESC
			LIMIT ? OFFSET ?`, leadColumnsFull, whereSQL)
	}
	args = append(args, limit, offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("marketplace lead list query: %w", err)
	}
	defer rows.Close()

	var result []marketplace.Lead
	for rows.Next() {
		var lead marketplace.Lead
		var err error
		if p.Summary {
			err = scanLeadSummary(rows, &lead)
		} else {
			err = scanLeadFull(rows, &lead)
		}
		if err != nil {
			return nil, 0, fmt.Errorf("marketplace lead scan: %w", err)
		}
		result = append(result, lead)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("marketplace lead rows: %w", err)
	}
	return result, total, nil
}

func (r *marketplaceRepo) buildWhere(p marketplace.ListParams) ([]string, []any) {
	where := []string{"ml.tenantId = ?"}
	args := []any{p.TenantID}

	if p.Provider != "" {
		where = append(where, "ml.provider = ?")
		args = append(args, p.Provider)
	}
	if p.Status != "" {
		where = append(where, "ml.status = ?")
		args = append(args, p.Status)
	}
	if p.From != nil {
		where = append(where, "ml.createdAt >= ?")
		args = append(args, *p.From)
	}
	if p.To != nil {
		where = append(where, "ml.createdAt <= ?")
		args = append(args, *p.To)
	}
	return where, args
}

func (r *marketplaceRepo) GetLeadByID(ctx context.Context, id, tenantID int) (*marketplace.Lead, error) {
	query := fmt.Sprintf(`
		SELECT %s
		FROM MarketplaceLead ml
		LEFT JOIN Contact c ON c.id = ml.contactId
		WHERE ml.id = ? AND ml.tenantId = ?`, leadColumnsFull)

	row := r.db.QueryRowContext(ctx, query, id, tenantID)
	var lead marketplace.Lead
	if err := scanLeadFull(row, &lead); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("marketplace lead get by id: %w", err)
	}
	return &lead, nil
}

func (r *marketplaceRepo) UpdateLeadStatus(ctx context.Context, id, tenantID int, status string) error {
	res, err := r.db.ExecContext(ctx,
		"UPDATE MarketplaceLead SET status = ? WHERE id = ? AND tenantId = ?",
		status, id, tenantID)
	if err != nil {
		return fmt.Errorf("marketplace lead update status: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *marketplaceRepo) UpdateLeadContactID(ctx context.Context, id, tenantID int, status string, contactID int) error {
	res, err := r.db.ExecContext(ctx,
		"UPDATE MarketplaceLead SET status = ?, contactId = ? WHERE id = ? AND tenantId = ?",
		status, contactID, id, tenantID)
	if err != nil {
		return fmt.Errorf("marketplace lead update contact id: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *marketplaceRepo) FindDuplicateContact(ctx context.Context, tenantID int, email, phone *string) (*marketplace.ContactSummary, error) {
	if (email == nil || *email == "") && (phone == nil || *phone == "") {
		return nil, nil
	}

	where := []string{"c.tenantId = ?", "c.deletedAt IS NULL"}
	args := []any{tenantID}

	or := []string{}
	if email != nil && *email != "" {
		or = append(or, "c.email = ?")
		args = append(args, *email)
	}
	if phone != nil && *phone != "" {
		or = append(or, "c.phone = ?")
		args = append(args, *phone)
	}
	where = append(where, "("+strings.Join(or, " OR ")+")")

	query := "SELECT c.id, c.name, c.email FROM Contact c WHERE " + strings.Join(where, " AND ") + " LIMIT 1"
	row := r.db.QueryRowContext(ctx, query, args...)
	var summary marketplace.ContactSummary
	var emailVal sql.NullString
	if err := row.Scan(&summary.ID, &summary.Name, &emailVal); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("find duplicate contact: %w", err)
	}
	summary.Email = nullStringPtr(emailVal)
	return &summary, nil
}

func (r *marketplaceRepo) CreateDeal(ctx context.Context, d *marketplace.Deal) error {
	res, err := r.db.ExecContext(ctx,
		"INSERT INTO Deal (title, amount, stage, contactId, tenantId) VALUES (?, ?, ?, ?, ?)",
		d.Title, d.Amount, d.Stage, d.ContactID, d.TenantID)
	if err != nil {
		return fmt.Errorf("create deal: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("create deal last id: %w", err)
	}
	d.ID = int(id)
	return nil
}

func (r *marketplaceRepo) GetStats(ctx context.Context, tenantID int) (*marketplace.StatsResult, error) {
	var total, thisWeek int
	if err := r.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM MarketplaceLead WHERE tenantId = ?", tenantID).Scan(&total); err != nil {
		return nil, fmt.Errorf("marketplace stats total: %w", err)
	}
	if err := r.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM MarketplaceLead WHERE tenantId = ? AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)", tenantID).Scan(&thisWeek); err != nil {
		return nil, fmt.Errorf("marketplace stats thisWeek: %w", err)
	}

	byProvider := map[string]int{}
	rows, err := r.db.QueryContext(ctx,
		"SELECT provider, COUNT(*) FROM MarketplaceLead WHERE tenantId = ? GROUP BY provider", tenantID)
	if err != nil {
		return nil, fmt.Errorf("marketplace stats byProvider: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var provider string
		var count int
		if err := rows.Scan(&provider, &count); err != nil {
			return nil, fmt.Errorf("marketplace stats byProvider scan: %w", err)
		}
		byProvider[provider] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("marketplace stats byProvider rows: %w", err)
	}

	byStatus := map[string]int{}
	rows2, err := r.db.QueryContext(ctx,
		"SELECT status, COUNT(*) FROM MarketplaceLead WHERE tenantId = ? GROUP BY status", tenantID)
	if err != nil {
		return nil, fmt.Errorf("marketplace stats byStatus: %w", err)
	}
	defer rows2.Close()
	for rows2.Next() {
		var status string
		var count int
		if err := rows2.Scan(&status, &count); err != nil {
			return nil, fmt.Errorf("marketplace stats byStatus scan: %w", err)
		}
		byStatus[status] = count
	}
	if err := rows2.Err(); err != nil {
		return nil, fmt.Errorf("marketplace stats byStatus rows: %w", err)
	}

	return &marketplace.StatsResult{
		Total:      total,
		ThisWeek:   thisWeek,
		ByProvider: mapToProviderCounts(byProvider),
		ByStatus:   mapToStatusCounts(byStatus),
	}, nil
}

func mapToProviderCounts(m map[string]int) []marketplace.ProviderCount {
	result := make([]marketplace.ProviderCount, 0, len(m))
	for provider, count := range m {
		result = append(result, marketplace.ProviderCount{Provider: provider, Count: count})
	}
	return result
}

func mapToStatusCounts(m map[string]int) []marketplace.StatusCount {
	result := make([]marketplace.StatusCount, 0, len(m))
	for status, count := range m {
		result = append(result, marketplace.StatusCount{Status: status, Count: count})
	}
	return result
}

func (r *marketplaceRepo) ListConfigs(ctx context.Context, tenantID int) ([]marketplace.Config, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT id, provider, apiKey, apiSecret, glueCrmKey, isActive, lastSyncAt, settings, createdAt, updatedAt, tenantId FROM MarketplaceConfig WHERE tenantId = ?",
		tenantID)
	if err != nil {
		return nil, fmt.Errorf("marketplace config list query: %w", err)
	}
	defer rows.Close()

	var result []marketplace.Config
	for rows.Next() {
		var cfg marketplace.Config
		var apiKey, apiSecret, glueCrmKey, settings sql.NullString
		var lastSyncAt, updatedAt sql.NullTime
		if err := rows.Scan(
			&cfg.ID, &cfg.Provider, &apiKey, &apiSecret, &glueCrmKey, &cfg.IsActive, &lastSyncAt, &settings,
			&cfg.CreatedAt, &updatedAt, &cfg.TenantID,
		); err != nil {
			return nil, fmt.Errorf("marketplace config list scan: %w", err)
		}
		cfg.ApiKey = nullStringPtr(apiKey)
		cfg.ApiSecret = nullStringPtr(apiSecret)
		cfg.GlueCrmKey = nullStringPtr(glueCrmKey)
		cfg.LastSyncAt = nullTimePtr(lastSyncAt)
		cfg.Settings = nullStringPtr(settings)
		cfg.UpdatedAt = nullTimePtr(updatedAt)
		result = append(result, cfg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("marketplace config list rows: %w", err)
	}
	return result, nil
}

func (r *marketplaceRepo) GetConfigByProvider(ctx context.Context, tenantID int, provider string) (*marketplace.Config, error) {
	row := r.db.QueryRowContext(ctx,
		"SELECT id, provider, apiKey, apiSecret, glueCrmKey, isActive, lastSyncAt, settings, createdAt, updatedAt, tenantId FROM MarketplaceConfig WHERE tenantId = ? AND provider = ?",
		tenantID, provider)

	var cfg marketplace.Config
	var apiKey, apiSecret, glueCrmKey, settings sql.NullString
	var lastSyncAt, updatedAt sql.NullTime
	if err := row.Scan(
		&cfg.ID, &cfg.Provider, &apiKey, &apiSecret, &glueCrmKey, &cfg.IsActive, &lastSyncAt, &settings,
		&cfg.CreatedAt, &updatedAt, &cfg.TenantID,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("marketplace config get by provider: %w", err)
	}
	cfg.ApiKey = nullStringPtr(apiKey)
	cfg.ApiSecret = nullStringPtr(apiSecret)
	cfg.GlueCrmKey = nullStringPtr(glueCrmKey)
	cfg.LastSyncAt = nullTimePtr(lastSyncAt)
	cfg.Settings = nullStringPtr(settings)
	cfg.UpdatedAt = nullTimePtr(updatedAt)
	return &cfg, nil
}

func (r *marketplaceRepo) CreateConfig(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO MarketplaceConfig (provider, apiKey, apiSecret, glueCrmKey, isActive, settings, tenantId, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
		cfg.Provider, cfg.ApiKey, cfg.ApiSecret, cfg.GlueCrmKey, cfg.IsActive, cfg.Settings, tenantID)
	if err != nil {
		return fmt.Errorf("marketplace config create: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("marketplace config create last id: %w", err)
	}
	cfg.ID = int(id)
	return nil
}

func (r *marketplaceRepo) UpdateConfig(ctx context.Context, tenantID int, cfg *marketplace.Config) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE MarketplaceConfig
		 SET apiKey = ?, apiSecret = ?, glueCrmKey = ?, isActive = ?, settings = ?, updatedAt = NOW()
		 WHERE tenantId = ? AND provider = ?`,
		cfg.ApiKey, cfg.ApiSecret, cfg.GlueCrmKey, cfg.IsActive, cfg.Settings, tenantID, cfg.Provider)
	if err != nil {
		return fmt.Errorf("marketplace config update: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func scanLeadFull(s scanner, lead *marketplace.Lead) error {
	var externalLeadID, rawPayload, name, email, phone, company, product, message, city sql.NullString
	var contactID, contactID2 sql.NullInt64
	var contactName sql.NullString
	var contactEmail sql.NullString
	var createdAt sql.NullTime

	err := s.Scan(
		&lead.ID, &lead.Provider, &externalLeadID, &rawPayload, &name, &email, &phone, &company,
		&product, &message, &city, &lead.Status, &contactID, &createdAt, &lead.TenantID,
		&contactID2, &contactName, &contactEmail,
	)
	if err != nil {
		return err
	}
	lead.ExternalLeadID = nullStringPtr(externalLeadID)
	lead.RawPayload = nullStringPtr(rawPayload)
	lead.Name = nullStringPtr(name)
	lead.Email = nullStringPtr(email)
	lead.Phone = nullStringPtr(phone)
	lead.Company = nullStringPtr(company)
	lead.Product = nullStringPtr(product)
	lead.Message = nullStringPtr(message)
	lead.City = nullStringPtr(city)
	lead.ContactID = nullIntPtr(contactID)
	lead.CreatedAt = createdAt.Time

	if contactID2.Valid {
		contact := marketplace.ContactSummary{
			ID: int(contactID2.Int64),
		}
		if contactName.Valid {
			contact.Name = contactName.String
		}
		contact.Email = nullStringPtr(contactEmail)
		lead.Contact = &contact
	}
	return nil
}

func scanLeadSummary(s scanner, lead *marketplace.Lead) error {
	var name sql.NullString
	var contactID sql.NullInt64
	var createdAt sql.NullTime

	err := s.Scan(
		&lead.ID, &lead.Provider, &name, &lead.Status, &contactID, &createdAt,
	)
	if err != nil {
		return err
	}
	lead.Name = nullStringPtr(name)
	lead.ContactID = nullIntPtr(contactID)
	lead.CreatedAt = createdAt.Time
	return nil
}

// Compile-time interface check.
var _ MarketplaceRepository = (*marketplaceRepo)(nil)
