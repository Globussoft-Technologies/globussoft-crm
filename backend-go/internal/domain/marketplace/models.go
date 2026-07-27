package marketplace

import "time"

// Lead mirrors the Prisma MarketplaceLead model scalar fields.
// The full shape includes a lightweight contact summary; the slim `fields=summary`
// shape omits both the PII-heavy lead columns and the contact join.
type Lead struct {
	ID             int             `json:"id"`
	Provider       string          `json:"provider"`
	ExternalLeadID *string         `json:"externalLeadId,omitempty"`
	RawPayload     *string         `json:"rawPayload,omitempty"`
	Name           *string         `json:"name,omitempty"`
	Email          *string         `json:"email,omitempty"`
	Phone          *string         `json:"phone,omitempty"`
	Company        *string         `json:"company,omitempty"`
	Product        *string         `json:"product,omitempty"`
	Message        *string         `json:"message,omitempty"`
	City           *string         `json:"city,omitempty"`
	Status         string          `json:"status"`
	ContactID      *int            `json:"contactId,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	TenantID       int             `json:"tenantId"`
	Contact        *ContactSummary `json:"contact,omitempty"`
}

// LeadSummary is the slim projection used when ?fields=summary is requested.
type LeadSummary struct {
	ID        int       `json:"id"`
	Provider  string    `json:"provider"`
	Name      *string   `json:"name,omitempty"`
	Status    string    `json:"status"`
	ContactID *int      `json:"contactId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// ContactSummary is the lightweight contact shape included in full lead responses.
// It mirrors the Node.js `include.contact` select of id, name, email.
type ContactSummary struct {
	ID    int     `json:"id"`
	Name  string  `json:"name"`
	Email *string `json:"email,omitempty"`
}

// Config mirrors the Prisma MarketplaceConfig model scalar fields.
type Config struct {
	ID         int        `json:"id"`
	Provider   string     `json:"provider"`
	ApiKey     *string    `json:"apiKey,omitempty"`
	ApiSecret  *string    `json:"apiSecret,omitempty"`
	GlueCrmKey *string    `json:"glueCrmKey,omitempty"`
	IsActive   bool       `json:"isActive"`
	LastSyncAt *time.Time `json:"lastSyncAt,omitempty"`
	Settings   *string    `json:"settings,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
	TenantID   int        `json:"tenantId"`
}

// UpsertConfigRequest is the body for PUT /api/marketplace-leads/config/:provider.
// Secrets are pointers so that omission can be distinguished from an explicit
// empty string; settings is any so it can accept either a JSON string or object.
type UpsertConfigRequest struct {
	ApiKey     *string `json:"apiKey,omitempty"`
	ApiSecret  *string `json:"apiSecret,omitempty"`
	GlueCrmKey *string `json:"glueCrmKey,omitempty"`
	IsActive   *bool   `json:"isActive,omitempty"`
	Settings   any     `json:"settings,omitempty"`
}

// ListParams drives the GET /api/marketplace-leads query-string contract.
type ListParams struct {
	TenantID int
	Provider string
	Status   string
	From     *time.Time
	To       *time.Time
	Page     int
	Limit    int
	Summary  bool
}

// Default values for the marketplace leads module.
const (
	DefaultPage  = 1
	DefaultLimit = 50
	MaxLimit     = 500
)

// Allowed lead statuses (best-effort; not enforced as a strict enum).
const (
	StatusNew       = "New"
	StatusImported  = "Imported"
	StatusDuplicate = "Duplicate"
	StatusDismissed = "Dismissed"
)

// StatsResult is the aggregated dashboard shape for GET /api/marketplace-leads/stats.
type StatsResult struct {
	Total          int             `json:"total"`
	ThisWeek       int             `json:"thisWeek"`
	ConversionRate float64         `json:"conversionRate"`
	ByProvider     []ProviderCount `json:"byProvider"`
	ByStatus       []StatusCount   `json:"byStatus"`
}

type ProviderCount struct {
	Provider string `json:"provider"`
	Count    int    `json:"count"`
}

type StatusCount struct {
	Status string `json:"status"`
	Count  int    `json:"count"`
}

// ImportResult is the response from importing a single lead.
type ImportResult struct {
	Imported  bool   `json:"imported"`
	Duplicate bool   `json:"duplicate,omitempty"`
	ContactID *int   `json:"contactId,omitempty"`
	Message   string `json:"message,omitempty"`
}

// BulkImportResult is the response from importing many leads.
type BulkImportResult struct {
	Imported   int `json:"imported"`
	Duplicates int `json:"duplicates"`
	Failed     int `json:"failed"`
}

// ConfigUpsertResult is the success response from a config upsert.
type ConfigUpsertResult struct {
	Success  bool   `json:"success"`
	Provider string `json:"provider"`
	IsActive bool   `json:"isActive"`
}

// Deal carries the minimal fields needed to create a Deal row from a marketplace import.
// It intentionally does not include all Prisma Deal columns; defaults cover the rest.
type Deal struct {
	ID        int
	Title     string
	Amount    float64
	Stage     string
	ContactID int
	TenantID  int
}
