package contacts

import "time"

// Contact mirrors the Prisma Contact model scalar fields.
// Relation fields (activities, deals, tasks, assignedTo, etc.) are intentionally
// omitted in this Phase 1 port and will be added as the migration progresses.
type Contact struct {
	ID                    int        `json:"id"`
	Name                  string     `json:"name"`
	Email                 *string    `json:"email,omitempty"`
	EmailVerifiedAt       *time.Time `json:"emailVerifiedAt,omitempty"`
	Phone                 *string    `json:"phone,omitempty"`
	Company               *string    `json:"company,omitempty"`
	Title                 *string    `json:"title,omitempty"`
	Status                string     `json:"status"`
	Source                *string    `json:"source,omitempty"`
	SubBrand              *string    `json:"subBrand,omitempty"`
	AIScore               int        `json:"aiScore"`
	AIScoreLastComputedAt *time.Time `json:"aiScoreLastComputedAt,omitempty"`

	Industry       *string    `json:"industry,omitempty"`
	CompanySize    *string    `json:"companySize,omitempty"`
	LinkedIn       *string    `json:"linkedin,omitempty"`
	Website        *string    `json:"website,omitempty"`
	LastEnrichedAt *time.Time `json:"lastEnrichedAt,omitempty"`

	FirstTouchSource *string `json:"firstTouchSource,omitempty"`
	LastTouchSource  *string `json:"lastTouchSource,omitempty"`

	TerritoryID *int `json:"territoryId,omitempty"`

	PortalPasswordHash *string `json:"-"`
	AvatarURL          *string `json:"avatarUrl,omitempty"`

	TreatmentOfInterest     *string `json:"treatmentOfInterest,omitempty"`
	PreferredLocationID     *int    `json:"preferredLocationId,omitempty"`
	PreferredPractitionerID *int    `json:"preferredPractitionerId,omitempty"`

	BirthDate     *time.Time `json:"birthDate,omitempty"`
	Anniversary   *time.Time `json:"anniversary,omitempty"`
	GST           *string    `json:"gst,omitempty"`
	WalletBalance *float64   `json:"walletBalance,omitempty"`

	StateCode        *string `json:"stateCode,omitempty"`
	BillingStateCode *string `json:"billingStateCode,omitempty"`

	CommissionProfileID *int `json:"commissionProfileId,omitempty"`

	KYCStatus      *string    `json:"kycStatus,omitempty"`
	KYCInitiatedAt *time.Time `json:"kycInitiatedAt,omitempty"`
	KYCVerifiedAt  *time.Time `json:"kycVerifiedAt,omitempty"`
	AadhaarLast4   *string    `json:"aadhaarLast4,omitempty"`
	KYCTokenID     *string    `json:"-"`

	ExternalID        *string `json:"externalId,omitempty"`
	IdempotencyKey    *string `json:"-"`
	ReferrerContactID *int    `json:"referrerContactId,omitempty"`

	Description *string `json:"description,omitempty"`

	FirstResponseDueAt *time.Time `json:"firstResponseDueAt,omitempty"`
	FirstResponseAt    *time.Time `json:"firstResponseAt,omitempty"`
	SlaBreached        bool       `json:"slaBreached"`
	SlaBreachedAt      *time.Time `json:"slaBreachedAt,omitempty"`

	TenantID     int  `json:"tenantId"`
	AssignedToID *int `json:"assignedToId,omitempty"`

	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
}

// ContactList holds a paginated list of contacts plus the total count.
type ContactList struct {
	Contacts []Contact `json:"contacts"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"pageSize"`
}

// CreateContactRequest is the body for POST /api/contacts.
type CreateContactRequest struct {
	Name                    string     `json:"name"`
	Email                   *string    `json:"email,omitempty"`
	Phone                   *string    `json:"phone,omitempty"`
	Company                 *string    `json:"company,omitempty"`
	Title                   *string    `json:"title,omitempty"`
	Status                  string     `json:"status"`
	Source                  *string    `json:"source,omitempty"`
	SubBrand                *string    `json:"subBrand,omitempty"`
	AIScore                 int        `json:"aiScore"`
	Industry                *string    `json:"industry,omitempty"`
	CompanySize             *string    `json:"companySize,omitempty"`
	LinkedIn                *string    `json:"linkedin,omitempty"`
	Website                 *string    `json:"website,omitempty"`
	TerritoryID             *int       `json:"territoryId,omitempty"`
	TreatmentOfInterest     *string    `json:"treatmentOfInterest,omitempty"`
	PreferredLocationID     *int       `json:"preferredLocationId,omitempty"`
	PreferredPractitionerID *int       `json:"preferredPractitionerId,omitempty"`
	BirthDate               *time.Time `json:"birthDate,omitempty"`
	Anniversary             *time.Time `json:"anniversary,omitempty"`
	GST                     *string    `json:"gst,omitempty"`
	StateCode               *string    `json:"stateCode,omitempty"`
	BillingStateCode        *string    `json:"billingStateCode,omitempty"`
	CommissionProfileID     *int       `json:"commissionProfileId,omitempty"`
	ExternalID              *string    `json:"externalId,omitempty"`
	AssignedToID            *int       `json:"assignedToId,omitempty"`
}

// UpdateContactRequest is the body for PUT /api/contacts/:id.
// Fields are pointers so that omission can be distinguished from an explicit null.
type UpdateContactRequest struct {
	Name                    *string    `json:"name,omitempty"`
	Email                   *string    `json:"email,omitempty"`
	Phone                   *string    `json:"phone,omitempty"`
	Company                 *string    `json:"company,omitempty"`
	Title                   *string    `json:"title,omitempty"`
	Status                  *string    `json:"status,omitempty"`
	Source                  *string    `json:"source,omitempty"`
	SubBrand                *string    `json:"subBrand,omitempty"`
	AIScore                 *int       `json:"aiScore,omitempty"`
	Industry                *string    `json:"industry,omitempty"`
	CompanySize             *string    `json:"companySize,omitempty"`
	LinkedIn                *string    `json:"linkedin,omitempty"`
	Website                 *string    `json:"website,omitempty"`
	TerritoryID             *int       `json:"territoryId,omitempty"`
	TreatmentOfInterest     *string    `json:"treatmentOfInterest,omitempty"`
	PreferredLocationID     *int       `json:"preferredLocationId,omitempty"`
	PreferredPractitionerID *int       `json:"preferredPractitionerId,omitempty"`
	BirthDate               *time.Time `json:"birthDate,omitempty"`
	Anniversary             *time.Time `json:"anniversary,omitempty"`
	GST                     *string    `json:"gst,omitempty"`
	StateCode               *string    `json:"stateCode,omitempty"`
	BillingStateCode        *string    `json:"billingStateCode,omitempty"`
	CommissionProfileID     *int       `json:"commissionProfileId,omitempty"`
	ExternalID              *string    `json:"externalId,omitempty"`
	AssignedToID            *int       `json:"assignedToId,omitempty"`
}

// ListParams filters and pagination for GET /api/contacts.
type ListParams struct {
	TenantID       int
	Search         string
	Status         string
	IncludeDeleted bool
	Page           int
	PageSize       int
}

// ValidateStatus returns true if the status is one of the allowed enum values.
func ValidateStatus(s string) bool {
	switch s {
	case "Lead", "Prospect", "Customer", "Churned", "Junk":
		return true
	}
	return false
}

// DefaultContactStatus is the default value for newly created contacts.
const DefaultContactStatus = "Lead"
