package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
)

// ContactRepository defines data access for contacts.
type ContactRepository interface {
	List(ctx context.Context, p contacts.ListParams) ([]contacts.Contact, int, error)
	GetByID(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error)
	Create(ctx context.Context, c *contacts.Contact) error
	Update(ctx context.Context, c *contacts.Contact) error
	SoftDelete(ctx context.Context, id, tenantID int) error
	Restore(ctx context.Context, id, tenantID int) error
}

// contactRepo is a database/sql implementation of ContactRepository.
type contactRepo struct {
	db *DB
}

// NewContactRepository returns a ContactRepository backed by database/sql.
func NewContactRepository(db *DB) ContactRepository {
	return &contactRepo{db: db}
}

// contactColumns is the canonical column list for Contact SELECT queries.
// It must stay in sync with scanContact and the Prisma schema.
const contactColumns = `
	c.id, c.name, c.email, c.emailVerifiedAt, c.phone, c.company, c.title, c.status, c.source, c.subBrand,
	c.aiScore, c.aiScoreLastComputedAt, c.industry, c.companySize, c.linkedin, c.website, c.lastEnrichedAt,
	c.firstTouchSource, c.lastTouchSource, c.territoryId, c.portalPasswordHash, c.avatarUrl,
	c.treatmentOfInterest, c.preferredLocationId, c.preferredPractitionerId, c.birthDate, c.anniversary,
	c.gst, c.walletBalance, c.stateCode, c.billingStateCode, c.commissionProfileId, c.kycStatus,
	c.kycInitiatedAt, c.kycVerifiedAt, c.aadhaarLast4, c.kycTokenId, c.externalId, c.idempotencyKey,
	c.referrerContactId, c.description, c.firstResponseDueAt, c.firstResponseAt, c.slaBreached,
	c.slaBreachedAt, c.createdAt, c.deletedAt, c.tenantId, c.assignedToId
`

func (r *contactRepo) List(ctx context.Context, p contacts.ListParams) ([]contacts.Contact, int, error) {
	where := []string{"c.tenantId = ?"}
	args := []any{p.TenantID}

	if !p.IncludeDeleted {
		where = append(where, "c.deletedAt IS NULL")
	}
	if p.Status != "" {
		where = append(where, "c.status = ?")
		args = append(args, p.Status)
	}
	if p.Search != "" {
		where = append(where, "(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.company LIKE ?)")
		like := "%" + p.Search + "%"
		args = append(args, like, like, like, like)
	}

	whereSQL := strings.Join(where, " AND ")

	var total int
	countQuery := "SELECT COUNT(*) FROM Contact c WHERE " + whereSQL
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("contact count query: %w", err)
	}

	page := p.Page
	if page < 1 {
		page = 1
	}
	pageSize := p.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 500 {
		pageSize = 500
	}
	offset := (page - 1) * pageSize

	query := fmt.Sprintf(`
		SELECT %s
		FROM Contact c
		WHERE %s
		ORDER BY c.id DESC
		LIMIT ? OFFSET ?`, contactColumns, whereSQL)
	args = append(args, pageSize, offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("contact list query: %w", err)
	}
	defer rows.Close()

	var result []contacts.Contact
	for rows.Next() {
		var c contacts.Contact
		if err := scanContact(rows, &c); err != nil {
			return nil, 0, fmt.Errorf("contact list scan: %w", err)
		}
		result = append(result, c)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("contact list rows: %w", err)
	}
	return result, total, nil
}

func (r *contactRepo) GetByID(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
	where := []string{"c.id = ?", "c.tenantId = ?"}
	args := []any{id, tenantID}
	if !includeDeleted {
		where = append(where, "c.deletedAt IS NULL")
	}

	query := fmt.Sprintf(`
		SELECT %s
		FROM Contact c
		WHERE %s`, contactColumns, strings.Join(where, " AND "))

	row := r.db.QueryRowContext(ctx, query, args...)
	var c contacts.Contact
	if err := scanContact(row, &c); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("contact get by id: %w", err)
	}
	return &c, nil
}

func (r *contactRepo) Create(ctx context.Context, c *contacts.Contact) error {
	// Use COALESCE defaults that mirror the Prisma schema.
	status := c.Status
	if status == "" {
		status = contacts.DefaultContactStatus
	}
	if c.Source == nil || *c.Source == "" {
		org := "Organic"
		c.Source = &org
	}

	query := `
		INSERT INTO Contact (
			name, email, phone, company, title, status, source, subBrand, aiScore,
			industry, companySize, linkedin, website, territoryId, treatmentOfInterest,
			preferredLocationId, preferredPractitionerId, birthDate, anniversary, gst,
			walletBalance, stateCode, billingStateCode, commissionProfileId, kycStatus,
			kycInitiatedAt, kycVerifiedAt, aadhaarLast4, kycTokenId, externalId,
			idempotencyKey, referrerContactId, description, firstResponseDueAt,
			firstResponseAt, slaBreached, slaBreachedAt, tenantId, assignedToId
		) VALUES (
			?, ?, ?, ?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?
		)`

	res, err := r.db.ExecContext(ctx, query,
		c.Name, c.Email, c.Phone, c.Company, c.Title, status, c.Source, c.SubBrand, c.AIScore,
		c.Industry, c.CompanySize, c.LinkedIn, c.Website, c.TerritoryID, c.TreatmentOfInterest,
		c.PreferredLocationID, c.PreferredPractitionerID, c.BirthDate, c.Anniversary, c.GST,
		c.WalletBalance, c.StateCode, c.BillingStateCode, c.CommissionProfileID, c.KYCStatus,
		c.KYCInitiatedAt, c.KYCVerifiedAt, c.AadhaarLast4, c.KYCTokenID, c.ExternalID,
		c.IdempotencyKey, c.ReferrerContactID, c.Description, c.FirstResponseDueAt,
		c.FirstResponseAt, c.SlaBreached, c.SlaBreachedAt, c.TenantID, c.AssignedToID,
	)
	if err != nil {
		return fmt.Errorf("contact create: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("contact create last id: %w", err)
	}
	c.ID = int(id)
	c.Status = status
	return nil
}

func (r *contactRepo) Update(ctx context.Context, c *contacts.Contact) error {
	// Build a dynamic update using only the populated scalar fields. The service
	// constructs a Contact where nil means "do not update" and a pointer/empty
	// value means "set to this value".
	set := []string{}
	args := []any{}

	add := func(col string, v any) {
		set = append(set, col+" = ?")
		args = append(args, v)
	}

	add("name", c.Name)
	add("email", c.Email)
	add("phone", c.Phone)
	add("company", c.Company)
	add("title", c.Title)
	add("status", c.Status)
	add("source", c.Source)
	add("subBrand", c.SubBrand)
	add("aiScore", c.AIScore)
	add("industry", c.Industry)
	add("companySize", c.CompanySize)
	add("linkedin", c.LinkedIn)
	add("website", c.Website)
	add("territoryId", c.TerritoryID)
	add("treatmentOfInterest", c.TreatmentOfInterest)
	add("preferredLocationId", c.PreferredLocationID)
	add("preferredPractitionerId", c.PreferredPractitionerID)
	add("birthDate", c.BirthDate)
	add("anniversary", c.Anniversary)
	add("gst", c.GST)
	add("walletBalance", c.WalletBalance)
	add("stateCode", c.StateCode)
	add("billingStateCode", c.BillingStateCode)
	add("commissionProfileId", c.CommissionProfileID)
	add("kycStatus", c.KYCStatus)
	add("kycInitiatedAt", c.KYCInitiatedAt)
	add("kycVerifiedAt", c.KYCVerifiedAt)
	add("aadhaarLast4", c.AadhaarLast4)
	add("kycTokenId", c.KYCTokenID)
	add("externalId", c.ExternalID)
	add("idempotencyKey", c.IdempotencyKey)
	add("referrerContactId", c.ReferrerContactID)
	add("description", c.Description)
	add("firstResponseDueAt", c.FirstResponseDueAt)
	add("firstResponseAt", c.FirstResponseAt)
	add("slaBreached", c.SlaBreached)
	add("slaBreachedAt", c.SlaBreachedAt)
	add("assignedToId", c.AssignedToID)

	if len(set) == 0 {
		return nil
	}

	args = append(args, c.ID, c.TenantID)
	query := fmt.Sprintf("UPDATE Contact SET %s WHERE id = ? AND tenantId = ?", strings.Join(set, ", "))
	if _, err := r.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("contact update: %w", err)
	}
	return nil
}

func (r *contactRepo) SoftDelete(ctx context.Context, id, tenantID int) error {
	res, err := r.db.ExecContext(ctx,
		"UPDATE Contact SET deletedAt = ? WHERE id = ? AND tenantId = ? AND deletedAt IS NULL",
		time.Now(), id, tenantID)
	if err != nil {
		return fmt.Errorf("contact soft delete: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *contactRepo) Restore(ctx context.Context, id, tenantID int) error {
	res, err := r.db.ExecContext(ctx,
		"UPDATE Contact SET deletedAt = NULL WHERE id = ? AND tenantId = ? AND deletedAt IS NOT NULL",
		id, tenantID)
	if err != nil {
		return fmt.Errorf("contact restore: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// scanner abstracts *sql.Row and *sql.Rows so scanContact can be reused.
type scanner interface {
	Scan(dest ...any) error
}

func scanContact(s scanner, c *contacts.Contact) error {
	var email, phone, company, title, source, subBrand sql.NullString
	var industry, companySize, linkedin, website sql.NullString
	var firstTouchSource, lastTouchSource, treatmentOfInterest sql.NullString
	var portalPasswordHash, avatarURL, gst, stateCode, billingStateCode sql.NullString
	var kycStatus, aadhaarLast4, kycTokenID, externalID, idempotencyKey, description sql.NullString
	var emailVerifiedAt, aiScoreLastComputedAt, lastEnrichedAt sql.NullTime
	var birthDate, anniversary, kycInitiatedAt, kycVerifiedAt sql.NullTime
	var firstResponseDueAt, firstResponseAt, slaBreachedAt, createdAt, deletedAt sql.NullTime
	var territoryID, preferredLocationID, preferredPractitionerID, commissionProfileID, referrerContactID sql.NullInt64
	var assignedToID sql.NullInt64
	var walletBalance sql.NullFloat64
	var slaBreached sql.NullBool

	err := s.Scan(
		&c.ID, &c.Name, &email, &emailVerifiedAt, &phone, &company, &title, &c.Status, &source, &subBrand,
		&c.AIScore, &aiScoreLastComputedAt, &industry, &companySize, &linkedin, &website, &lastEnrichedAt,
		&firstTouchSource, &lastTouchSource, &territoryID, &portalPasswordHash, &avatarURL,
		&treatmentOfInterest, &preferredLocationID, &preferredPractitionerID, &birthDate, &anniversary,
		&gst, &walletBalance, &stateCode, &billingStateCode, &commissionProfileID, &kycStatus,
		&kycInitiatedAt, &kycVerifiedAt, &aadhaarLast4, &kycTokenID, &externalID, &idempotencyKey,
		&referrerContactID, &description, &firstResponseDueAt, &firstResponseAt, &slaBreached,
		&slaBreachedAt, &createdAt, &deletedAt, &c.TenantID, &assignedToID,
	)
	if err != nil {
		return err
	}

	c.Email = nullStringPtr(email)
	c.EmailVerifiedAt = nullTimePtr(emailVerifiedAt)
	c.Phone = nullStringPtr(phone)
	c.Company = nullStringPtr(company)
	c.Title = nullStringPtr(title)
	c.Source = nullStringPtr(source)
	c.SubBrand = nullStringPtr(subBrand)
	c.AIScoreLastComputedAt = nullTimePtr(aiScoreLastComputedAt)
	c.Industry = nullStringPtr(industry)
	c.CompanySize = nullStringPtr(companySize)
	c.LinkedIn = nullStringPtr(linkedin)
	c.Website = nullStringPtr(website)
	c.LastEnrichedAt = nullTimePtr(lastEnrichedAt)
	c.FirstTouchSource = nullStringPtr(firstTouchSource)
	c.LastTouchSource = nullStringPtr(lastTouchSource)
	c.TerritoryID = nullIntPtr(territoryID)
	c.PortalPasswordHash = nullStringPtr(portalPasswordHash)
	c.AvatarURL = nullStringPtr(avatarURL)
	c.TreatmentOfInterest = nullStringPtr(treatmentOfInterest)
	c.PreferredLocationID = nullIntPtr(preferredLocationID)
	c.PreferredPractitionerID = nullIntPtr(preferredPractitionerID)
	c.BirthDate = nullTimePtr(birthDate)
	c.Anniversary = nullTimePtr(anniversary)
	c.GST = nullStringPtr(gst)
	c.WalletBalance = nullFloatPtr(walletBalance)
	c.StateCode = nullStringPtr(stateCode)
	c.BillingStateCode = nullStringPtr(billingStateCode)
	c.CommissionProfileID = nullIntPtr(commissionProfileID)
	c.KYCStatus = nullStringPtr(kycStatus)
	c.KYCInitiatedAt = nullTimePtr(kycInitiatedAt)
	c.KYCVerifiedAt = nullTimePtr(kycVerifiedAt)
	c.AadhaarLast4 = nullStringPtr(aadhaarLast4)
	c.KYCTokenID = nullStringPtr(kycTokenID)
	c.ExternalID = nullStringPtr(externalID)
	c.IdempotencyKey = nullStringPtr(idempotencyKey)
	c.ReferrerContactID = nullIntPtr(referrerContactID)
	c.Description = nullStringPtr(description)
	c.FirstResponseDueAt = nullTimePtr(firstResponseDueAt)
	c.FirstResponseAt = nullTimePtr(firstResponseAt)
	c.SlaBreached = slaBreached.Valid && slaBreached.Bool
	c.SlaBreachedAt = nullTimePtr(slaBreachedAt)
	c.CreatedAt = createdAt.Time
	c.DeletedAt = nullTimePtr(deletedAt)
	c.AssignedToID = nullIntPtr(assignedToID)

	return nil
}

func nullStringPtr(ns sql.NullString) *string {
	if ns.Valid {
		return &ns.String
	}
	return nil
}

func nullIntPtr(ni sql.NullInt64) *int {
	if ni.Valid {
		v := int(ni.Int64)
		return &v
	}
	return nil
}

func nullFloatPtr(nf sql.NullFloat64) *float64 {
	if nf.Valid {
		return &nf.Float64
	}
	return nil
}

func nullTimePtr(nt sql.NullTime) *time.Time {
	if nt.Valid {
		return &nt.Time
	}
	return nil
}
