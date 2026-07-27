package tasks

import (
	"encoding/json"
	"strings"
	"time"
)

// Task mirrors the Prisma Task model scalar fields plus best-effort nested
// summaries for the contact and assignee. Relation fields are loaded on demand
// by the service layer; the summary shape omits PII-heavy fields.
type Task struct {
	ID        int        `json:"id"`
	Title     string     `json:"title"`
	DueDate   *time.Time `json:"dueDate,omitempty"`
	Status    string     `json:"status"`
	Priority  string     `json:"priority"`
	Notes     *string    `json:"notes,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`

	TenantID  int  `json:"tenantId"`
	ContactID *int `json:"contactId,omitempty"`
	UserID    *int `json:"userId,omitempty"`
	ProjectID *int `json:"projectId,omitempty"`

	Contact *ContactSummary `json:"contact,omitempty"`
	User    *UserSummary    `json:"user,omitempty"`
}

// ContactSummary is the lightweight contact shape included in full task responses.
type ContactSummary struct {
	ID      int     `json:"id"`
	Name    string  `json:"name"`
	Email   *string `json:"email,omitempty"`
	Phone   *string `json:"phone,omitempty"`
	Company *string `json:"company,omitempty"`
}

// UserSummary is the lightweight assignee shape included in full task responses.
type UserSummary struct {
	ID             int     `json:"id"`
	Name           string  `json:"name"`
	Email          string  `json:"email"`
	Role           string  `json:"role"`
	ProfilePicture *string `json:"profilePicture,omitempty"`
}

// CreateTaskRequest is the body for POST /api/tasks.
type CreateTaskRequest struct {
	Title        string `json:"title"`
	DueDate      string `json:"dueDate,omitempty"`
	ContactID    int    `json:"contactId,omitempty"`
	TargetUserID int    `json:"targetUserId,omitempty"`
	UserID       int    `json:"userId,omitempty"` // fallback assignee for legacy clients
	Notes        string `json:"notes,omitempty"`
	Priority     string `json:"priority,omitempty"`
}

// UpdateTaskRequest is the body for PUT /api/tasks/:id.
// Pointers distinguish omission from an explicit null/empty value.
// dueDate uses json.RawMessage so we can tell "field omitted" from "field set to null".
type UpdateTaskRequest struct {
	Title    *string         `json:"title,omitempty"`
	Notes    *string         `json:"notes,omitempty"`
	DueDate  json.RawMessage `json:"dueDate,omitempty"`
	Priority *string         `json:"priority,omitempty"`
	Status   *string         `json:"status,omitempty"`
}

// ListParams holds all query-driven filters and pagination for GET /api/tasks.
type ListParams struct {
	TenantID       int
	Status         string // normalized canonical status
	Priority       string
	ContactID      int
	Overdue        bool
	Mine           bool
	IncludeDeleted bool
	Count          bool
	Limit          int
	Offset         int
	Summary        bool
	CallerUserID   int
	CallerRole     string
}

// Default values for the task module.
const (
	DefaultStatus   = "Pending"
	DefaultPriority = "Medium"
)

// Allowed task statuses and priorities. These match the Prisma enum comments.
var (
	allowedStatuses = map[string]struct{}{
		"Pending":     {},
		"In Progress": {},
		"Completed":   {},
		"Cancelled":   {},
	}
	allowedPriorities = map[string]struct{}{
		"Low":      {},
		"Medium":   {},
		"High":     {},
		"Critical": {},
	}
	priorityOrder = map[string]int{
		"Critical": 0,
		"High":     1,
		"Medium":   2,
		"Low":      3,
	}
)

// ValidateStatus returns true if the status is one of the allowed values.
func ValidateStatus(s string) bool {
	_, ok := allowedStatuses[s]
	return ok
}

// ValidatePriority returns true if the priority is one of the allowed values.
func ValidatePriority(s string) bool {
	_, ok := allowedPriorities[s]
	return ok
}

// PriorityRank returns the priority sort rank (lower = first). Unknown priorities sort last.
func PriorityRank(p string) int {
	if r, ok := priorityOrder[p]; ok {
		return r
	}
	return 99
}

// NormalizeStatusFilter maps legacy / uppercase query-string status values to
// the canonical enum value used by the database and UI. Unrecognized values
// are returned unchanged so they exact-match (and typically return empty).
func NormalizeStatusFilter(raw string) string {
	upper := strings.ToUpper(strings.TrimSpace(raw))
	switch upper {
	case "PENDING", "OPEN":
		return "Pending"
	case "COMPLETED", "DONE", "CLOSED":
		return "Completed"
	case "IN PROGRESS", "INPROGRESS":
		return "In Progress"
	case "CANCELLED", "CANCELED":
		return "Cancelled"
	default:
		return raw
	}
}
