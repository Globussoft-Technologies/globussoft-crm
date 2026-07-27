package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
)

// ContactService defines the contacts use-case interface.
type ContactService interface {
	List(ctx context.Context, tenantID int, p contacts.ListParams) ([]contacts.Contact, int, error)
	GetByID(ctx context.Context, tenantID, id int, includeDeleted bool) (*contacts.Contact, error)
	Create(ctx context.Context, userID, tenantID int, req contacts.CreateContactRequest) (*contacts.Contact, error)
	Update(ctx context.Context, userID, tenantID, id int, req contacts.UpdateContactRequest) (*contacts.Contact, error)
	Delete(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error)
	Restore(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error)
}

// contactSvc is the production implementation.
type contactSvc struct {
	repo repository.ContactRepository
	db   shared.SQLExecer
}

// NewContactService returns a ContactService.
func NewContactService(repo repository.ContactRepository, db shared.SQLExecer) ContactService {
	return &contactSvc{repo: repo, db: db}
}

// emailRE is a simple RFC-ish email validator matching the Node backend's loose regex.
var emailRE = regexp.MustCompile(`^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$`)

// gstRE is the canonical 15-character India GSTIN format.
var gstRE = regexp.MustCompile(`^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Z][0-9A-Z]$`)

func (s *contactSvc) List(ctx context.Context, tenantID int, p contacts.ListParams) ([]contacts.Contact, int, error) {
	p.TenantID = tenantID
	return s.repo.List(ctx, p)
}

func (s *contactSvc) GetByID(ctx context.Context, tenantID, id int, includeDeleted bool) (*contacts.Contact, error) {
	return s.repo.GetByID(ctx, id, tenantID, includeDeleted)
}

func (s *contactSvc) Create(ctx context.Context, userID, tenantID int, req contacts.CreateContactRequest) (*contacts.Contact, error) {
	if err := validateCreate(req); err != nil {
		return nil, err
	}

	c := contacts.Contact{
		Name:                    strings.TrimSpace(req.Name),
		Email:                   req.Email,
		Phone:                   req.Phone,
		Company:                 req.Company,
		Title:                   req.Title,
		Status:                  req.Status,
		Source:                  req.Source,
		SubBrand:                req.SubBrand,
		AIScore:                 req.AIScore,
		Industry:                req.Industry,
		CompanySize:             req.CompanySize,
		LinkedIn:                req.LinkedIn,
		Website:                 req.Website,
		TerritoryID:             req.TerritoryID,
		TreatmentOfInterest:     req.TreatmentOfInterest,
		PreferredLocationID:     req.PreferredLocationID,
		PreferredPractitionerID: req.PreferredPractitionerID,
		BirthDate:               req.BirthDate,
		Anniversary:             req.Anniversary,
		GST:                     req.GST,
		StateCode:               req.StateCode,
		BillingStateCode:        req.BillingStateCode,
		CommissionProfileID:     req.CommissionProfileID,
		ExternalID:              req.ExternalID,
		AssignedToID:            req.AssignedToID,
		TenantID:                tenantID,
	}
	if c.Status == "" {
		c.Status = contacts.DefaultContactStatus
	}
	if c.Source == nil || *c.Source == "" {
		source := "Organic"
		c.Source = &source
	}
	// Mirror Node backend: default assignedToId to the creator so USER-role
	// list scoping surfaces the contact they just created.
	if c.AssignedToID == nil {
		c.AssignedToID = &userID
	}

	if err := s.repo.Create(ctx, &c); err != nil {
		return nil, fmt.Errorf("create contact: %w", err)
	}

	details := map[string]any{"name": c.Name, "email": c.Email}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Contact", "CREATE", c.ID, userID, tenantID, string(detailsJSON))

	return &c, nil
}

func (s *contactSvc) Update(ctx context.Context, userID, tenantID, id int, req contacts.UpdateContactRequest) (*contacts.Contact, error) {
	existing, err := s.repo.GetByID(ctx, id, tenantID, false)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, sql.ErrNoRows
	}

	if err := validateUpdate(req); err != nil {
		return nil, err
	}

	c := *existing
	if req.Name != nil {
		c.Name = strings.TrimSpace(*req.Name)
	}
	if req.Email != nil {
		c.Email = req.Email
	}
	if req.Phone != nil {
		c.Phone = req.Phone
	}
	if req.Company != nil {
		c.Company = req.Company
	}
	if req.Title != nil {
		c.Title = req.Title
	}
	if req.Status != nil {
		c.Status = *req.Status
	}
	if req.Source != nil {
		c.Source = req.Source
	}
	if req.SubBrand != nil {
		c.SubBrand = req.SubBrand
	}
	if req.AIScore != nil {
		c.AIScore = *req.AIScore
	}
	if req.Industry != nil {
		c.Industry = req.Industry
	}
	if req.CompanySize != nil {
		c.CompanySize = req.CompanySize
	}
	if req.LinkedIn != nil {
		c.LinkedIn = req.LinkedIn
	}
	if req.Website != nil {
		c.Website = req.Website
	}
	if req.TerritoryID != nil {
		c.TerritoryID = req.TerritoryID
	}
	if req.TreatmentOfInterest != nil {
		c.TreatmentOfInterest = req.TreatmentOfInterest
	}
	if req.PreferredLocationID != nil {
		c.PreferredLocationID = req.PreferredLocationID
	}
	if req.PreferredPractitionerID != nil {
		c.PreferredPractitionerID = req.PreferredPractitionerID
	}
	if req.BirthDate != nil {
		c.BirthDate = req.BirthDate
	}
	if req.Anniversary != nil {
		c.Anniversary = req.Anniversary
	}
	if req.GST != nil {
		c.GST = req.GST
	}
	if req.StateCode != nil {
		c.StateCode = req.StateCode
	}
	if req.BillingStateCode != nil {
		c.BillingStateCode = req.BillingStateCode
	}
	if req.CommissionProfileID != nil {
		c.CommissionProfileID = req.CommissionProfileID
	}
	if req.ExternalID != nil {
		c.ExternalID = req.ExternalID
	}
	if req.AssignedToID != nil {
		c.AssignedToID = req.AssignedToID
	}

	if err := s.repo.Update(ctx, &c); err != nil {
		return nil, fmt.Errorf("update contact: %w", err)
	}

	// Reload so the response reflects the persisted row.
	updated, err := s.repo.GetByID(ctx, id, tenantID, false)
	if err != nil {
		return nil, err
	}

	changes := diffContact(existing, updated)
	if len(changes) > 0 {
		changesJSON, _ := json.Marshal(changes)
		_ = shared.WriteAudit(ctx, s.db, "Contact", "UPDATE", id, userID, tenantID, string(changesJSON))
	}

	return updated, nil
}

func (s *contactSvc) Delete(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error) {
	existing, err := s.repo.GetByID(ctx, id, tenantID, true)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, sql.ErrNoRows
	}
	if existing.DeletedAt != nil {
		return existing, nil
	}

	if err := s.repo.SoftDelete(ctx, id, tenantID); err != nil {
		return nil, fmt.Errorf("delete contact: %w", err)
	}

	now := time.Now()
	existing.DeletedAt = &now

	details := map[string]any{"name": existing.Name, "email": existing.Email}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Contact", "SOFT_DELETE", id, userID, tenantID, string(detailsJSON))

	return existing, nil
}

func (s *contactSvc) Restore(ctx context.Context, userID, tenantID, id int) (*contacts.Contact, error) {
	existing, err := s.repo.GetByID(ctx, id, tenantID, true)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, sql.ErrNoRows
	}
	if existing.DeletedAt == nil {
		return existing, nil
	}

	if err := s.repo.Restore(ctx, id, tenantID); err != nil {
		return nil, fmt.Errorf("restore contact: %w", err)
	}

	existing.DeletedAt = nil

	details := map[string]any{"name": existing.Name}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Contact", "RESTORE", id, userID, tenantID, string(detailsJSON))

	return existing, nil
}

// ValidationError is a domain-level validation failure.
type ValidationError struct {
	Field   string `json:"field,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e ValidationError) Error() string {
	return e.Message
}

func validateCreate(req contacts.CreateContactRequest) error {
	if strings.TrimSpace(req.Name) == "" {
		return ValidationError{Field: "name", Code: "NAME_REQUIRED", Message: "name is required"}
	}
	if len(req.Name) > 200 {
		return ValidationError{Field: "name", Code: "NAME_TOO_LONG", Message: "name must be ≤ 200 characters"}
	}
	if req.Email == nil || strings.TrimSpace(*req.Email) == "" {
		return ValidationError{Field: "email", Code: "EMAIL_REQUIRED", Message: "email is required"}
	}
	if !emailRE.MatchString(strings.TrimSpace(*req.Email)) {
		return ValidationError{Field: "email", Code: "INVALID_EMAIL", Message: "email is invalid"}
	}
	return validateOptional(req.Status, req.AIScore, req.GST, req.StateCode, req.BillingStateCode, req.BirthDate, req.Anniversary)
}

func validateUpdate(req contacts.UpdateContactRequest) error {
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		return ValidationError{Field: "name", Code: "NAME_REQUIRED", Message: "name cannot be empty"}
	}
	if req.Name != nil && len(*req.Name) > 200 {
		return ValidationError{Field: "name", Code: "NAME_TOO_LONG", Message: "name must be ≤ 200 characters"}
	}
	if req.Email != nil && strings.TrimSpace(*req.Email) != "" && !emailRE.MatchString(strings.TrimSpace(*req.Email)) {
		return ValidationError{Field: "email", Code: "INVALID_EMAIL", Message: "email is invalid"}
	}
	var status string
	if req.Status != nil {
		status = *req.Status
	}
	var aiScore int
	if req.AIScore != nil {
		aiScore = *req.AIScore
	}
	return validateOptional(status, aiScore, req.GST, req.StateCode, req.BillingStateCode, req.BirthDate, req.Anniversary)
}

func validateOptional(status string, aiScore int, gst, stateCode, billingStateCode *string, birthDate, anniversary *time.Time) error {
	if status != "" && !contacts.ValidateStatus(status) {
		return ValidationError{Field: "status", Code: "INVALID_STATUS", Message: "status must be Lead, Prospect, Customer, Churned or Junk"}
	}
	if aiScore < 0 || aiScore > 100 {
		return ValidationError{Field: "aiScore", Code: "INVALID_AISCORE", Message: "aiScore must be between 0 and 100"}
	}
	if gst != nil && *gst != "" && !gstRE.MatchString(*gst) {
		return ValidationError{Field: "gst", Code: "INVALID_GST", Message: "gst must be a valid 15-character GSTIN"}
	}
	for _, field := range []struct {
		name *string
		key  string
	}{
		{stateCode, "stateCode"},
		{billingStateCode, "billingStateCode"},
	} {
		if field.name != nil && len(*field.name) > 10 {
			return ValidationError{Field: field.key, Code: "INVALID_STATE_CODE", Message: field.key + " must be ≤ 10 characters"}
		}
	}
	if birthDate != nil && birthDate.After(time.Now()) {
		return ValidationError{Field: "birthDate", Code: "INVALID_BIRTHDATE", Message: "birthDate cannot be in the future"}
	}
	if anniversary != nil && anniversary.Year() < 1900 {
		return ValidationError{Field: "anniversary", Code: "INVALID_ANNIVERSARY", Message: "anniversary year must be ≥ 1900"}
	}
	if anniversary != nil && anniversary.After(time.Now().AddDate(1, 0, 0)) {
		return ValidationError{Field: "anniversary", Code: "INVALID_ANNIVERSARY", Message: "anniversary cannot be more than 1 year in the future"}
	}
	return nil
}

func diffContact(before, after *contacts.Contact) map[string]any {
	changes := map[string]any{}
	if before.Name != after.Name {
		changes["name"] = map[string]any{"from": before.Name, "to": after.Name}
	}
	if !ptrEqual(before.Email, after.Email) {
		changes["email"] = map[string]any{"from": before.Email, "to": after.Email}
	}
	if !ptrEqual(before.Phone, after.Phone) {
		changes["phone"] = map[string]any{"from": before.Phone, "to": after.Phone}
	}
	if !ptrEqual(before.Company, after.Company) {
		changes["company"] = map[string]any{"from": before.Company, "to": after.Company}
	}
	if !ptrEqual(before.Title, after.Title) {
		changes["title"] = map[string]any{"from": before.Title, "to": after.Title}
	}
	if before.Status != after.Status {
		changes["status"] = map[string]any{"from": before.Status, "to": after.Status}
	}
	if !ptrEqual(before.Source, after.Source) {
		changes["source"] = map[string]any{"from": before.Source, "to": after.Source}
	}
	if before.AIScore != after.AIScore {
		changes["aiScore"] = map[string]any{"from": before.AIScore, "to": after.AIScore}
	}
	if !ptrEqual(before.GST, after.GST) {
		changes["gst"] = map[string]any{"from": before.GST, "to": after.GST}
	}
	if !ptrEqual(before.AssignedToID, after.AssignedToID) {
		changes["assignedToId"] = map[string]any{"from": before.AssignedToID, "to": after.AssignedToID}
	}
	return changes
}

func ptrEqual[T comparable](a, b *T) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// Compile-time interface check.
var _ ContactService = (*contactSvc)(nil)
