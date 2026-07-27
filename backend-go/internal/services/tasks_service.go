package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/tasks"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
)

// TaskService defines the tasks use-case interface.
type TaskService interface {
	List(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error)
	Create(ctx context.Context, userID, tenantID int, req tasks.CreateTaskRequest) (*tasks.Task, error)
	Update(ctx context.Context, userID, tenantID, id int, req tasks.UpdateTaskRequest) (*tasks.Task, error)
	Complete(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error)
	Delete(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error)
	Restore(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error)
}

type taskSvc struct {
	repo repository.TaskRepository
	db   shared.SQLExecer
}

// NewTaskService returns a TaskService.
func NewTaskService(repo repository.TaskRepository, db shared.SQLExecer) TaskService {
	return &taskSvc{repo: repo, db: db}
}

// datetimeLocalRE matches HTML datetime-local inputs without a timezone.
var datetimeLocalRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$`)

func (s *taskSvc) List(ctx context.Context, tenantID int, p tasks.ListParams) ([]tasks.Task, int, error) {
	p.TenantID = tenantID
	tt, total, err := s.repo.List(ctx, p)
	if err != nil {
		return nil, 0, err
	}
	if p.Count || p.Summary {
		return tt, total, nil
	}

	sort.SliceStable(tt, func(i, j int) bool {
		pi := tasks.PriorityRank(tt[i].Priority)
		pj := tasks.PriorityRank(tt[j].Priority)
		if pi != pj {
			return pi < pj
		}
		return tt[i].CreatedAt.After(tt[j].CreatedAt)
	})

	if err := s.populate(ctx, tt); err != nil {
		return nil, 0, err
	}
	return tt, total, nil
}

func (s *taskSvc) Create(ctx context.Context, userID, tenantID int, req tasks.CreateTaskRequest) (*tasks.Task, error) {
	if err := validateTaskCreate(req); err != nil {
		return nil, err
	}

	dueDate, err := parseDueDate(req.DueDate)
	if err != nil {
		return nil, ValidationError{Field: "dueDate", Code: "INVALID_DUEDATE", Message: "Invalid due date"}
	}

	priority := req.Priority
	if priority == "" {
		priority = tasks.DefaultPriority
	}
	if !tasks.ValidatePriority(priority) {
		return nil, ValidationError{Field: "priority", Code: "INVALID_PRIORITY", Message: "priority must be Low, Medium, High or Critical"}
	}

	assigneeID := pickAssignee(req.TargetUserID, req.UserID)

	var notes *string
	if strings.TrimSpace(req.Notes) != "" {
		n := strings.TrimSpace(req.Notes)
		notes = &n
	}

	var contactID *int
	if req.ContactID > 0 {
		contactID = &req.ContactID
	}

	t := tasks.Task{
		Title:     strings.TrimSpace(req.Title),
		Status:    tasks.DefaultStatus,
		Priority:  priority,
		DueDate:   dueDate,
		Notes:     notes,
		TenantID:  tenantID,
		ContactID: contactID,
		UserID:    assigneeID,
	}

	if err := s.repo.Create(ctx, &t); err != nil {
		return nil, fmt.Errorf("create task: %w", err)
	}

	loaded, err := s.getByIDWithRelations(ctx, t.ID, tenantID, false)
	if err != nil {
		return nil, err
	}

	assignedTo := loaded.UserID
	details := map[string]any{
		"title":      loaded.Title,
		"priority":   loaded.Priority,
		"assignedTo": assignedTo,
		"contactId":  loaded.ContactID,
	}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Task", "CREATE", loaded.ID, userID, tenantID, string(detailsJSON))

	return loaded, nil
}

func (s *taskSvc) Update(ctx context.Context, userID, tenantID, id int, req tasks.UpdateTaskRequest) (*tasks.Task, error) {
	existing, err := s.getByIDWithRelations(ctx, id, tenantID, false)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, sql.ErrNoRows
	}

	if err := validateTaskUpdate(req); err != nil {
		return nil, err
	}

	wasCompleted := existing.Status == "Completed"

	updated := *existing
	changed := false

	if req.Title != nil {
		v := strings.TrimSpace(*req.Title)
		if v != updated.Title {
			updated.Title = v
			changed = true
		}
	}
	if req.Notes != nil {
		v := strings.TrimSpace(*req.Notes)
		var notes *string
		if v != "" {
			notes = &v
		}
		if !ptrStringEqual(notes, updated.Notes) {
			updated.Notes = notes
			changed = true
		}
	}
	if req.DueDate != nil {
		raw := string(req.DueDate)
		if raw == "null" {
			if updated.DueDate != nil {
				updated.DueDate = nil
				changed = true
			}
		} else {
			var s string
			if err := json.Unmarshal(req.DueDate, &s); err != nil {
				return nil, ValidationError{Field: "dueDate", Code: "INVALID_DUEDATE", Message: "Invalid due date"}
			}
			dueDate, err := parseDueDate(s)
			if err != nil {
				return nil, ValidationError{Field: "dueDate", Code: "INVALID_DUEDATE", Message: "Invalid due date"}
			}
			if !ptrTimeEqual(dueDate, updated.DueDate) {
				updated.DueDate = dueDate
				changed = true
			}
		}
	}
	if req.Priority != nil {
		v := *req.Priority
		if !tasks.ValidatePriority(v) {
			return nil, ValidationError{Field: "priority", Code: "INVALID_PRIORITY", Message: "priority must be Low, Medium, High or Critical"}
		}
		if v != updated.Priority {
			updated.Priority = v
			changed = true
		}
	}
	if req.Status != nil {
		v := *req.Status
		if !tasks.ValidateStatus(v) {
			return nil, ValidationError{Field: "status", Code: "INVALID_STATUS", Message: "status must be Pending, In Progress, Completed or Cancelled"}
		}
		if v != updated.Status {
			updated.Status = v
			changed = true
		}
	}

	if !changed {
		return existing, nil
	}

	if err := s.repo.Update(ctx, &updated); err != nil {
		return nil, fmt.Errorf("update task: %w", err)
	}

	// Reload to ensure the response reflects the persisted row and any
	// changed contact/user summaries are up to date.
	reloaded, err := s.getByIDWithRelations(ctx, id, tenantID, false)
	if err != nil {
		return nil, err
	}

	// TODO: eventBus emit task.completed on Pending -> Completed transition.
	if !wasCompleted && reloaded.Status == "Completed" {
		// eventBus.emit("task.completed", ...)
	}

	changes := diffTask(existing, reloaded)
	if len(changes) > 0 {
		changesJSON, _ := json.Marshal(map[string]any{"changedFields": changes})
		_ = shared.WriteAudit(ctx, s.db, "Task", "UPDATE", id, userID, tenantID, string(changesJSON))
	}

	return reloaded, nil
}

func (s *taskSvc) Complete(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
	existing, err := s.getByIDWithRelations(ctx, id, tenantID, false)
	if err != nil {
		return nil, false, err
	}
	if existing == nil {
		return nil, false, sql.ErrNoRows
	}
	if existing.Status == "Completed" {
		return existing, true, nil
	}

	updated := *existing
	updated.Status = "Completed"
	if err := s.repo.Update(ctx, &updated); err != nil {
		return nil, false, fmt.Errorf("complete task: %w", err)
	}

	// TODO: eventBus emit task.completed.

	details := map[string]any{"title": existing.Title}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Task", "COMPLETE", id, userID, tenantID, string(detailsJSON))

	return &updated, false, nil
}

func (s *taskSvc) Delete(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
	existing, err := s.getByIDWithRelations(ctx, id, tenantID, true)
	if err != nil {
		return nil, false, err
	}
	if existing == nil {
		return nil, false, sql.ErrNoRows
	}
	if existing.DeletedAt != nil {
		return existing, true, nil
	}

	if err := s.repo.SoftDelete(ctx, id, tenantID); err != nil {
		return nil, false, fmt.Errorf("delete task: %w", err)
	}

	now := time.Now()
	existing.DeletedAt = &now

	details := map[string]any{"title": existing.Title}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Task", "SOFT_DELETE", id, userID, tenantID, string(detailsJSON))

	return existing, false, nil
}

func (s *taskSvc) Restore(ctx context.Context, userID, tenantID, id int) (*tasks.Task, bool, error) {
	existing, err := s.getByIDWithRelations(ctx, id, tenantID, true)
	if err != nil {
		return nil, false, err
	}
	if existing == nil {
		return nil, false, sql.ErrNoRows
	}
	if existing.DeletedAt == nil {
		return existing, true, nil
	}

	if err := s.repo.Restore(ctx, id, tenantID); err != nil {
		return nil, false, fmt.Errorf("restore task: %w", err)
	}

	existing.DeletedAt = nil

	details := map[string]any{"title": existing.Title}
	detailsJSON, _ := json.Marshal(details)
	_ = shared.WriteAudit(ctx, s.db, "Task", "RESTORE", id, userID, tenantID, string(detailsJSON))

	return existing, false, nil
}

func (s *taskSvc) getByIDWithRelations(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
	t, err := s.repo.GetByID(ctx, id, tenantID, includeDeleted)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil
	}
	tmp := []tasks.Task{*t}
	if err := s.populate(ctx, tmp); err != nil {
		return nil, err
	}
	*t = tmp[0]
	return t, nil
}

func (s *taskSvc) populate(ctx context.Context, tt []tasks.Task) error {
	if len(tt) == 0 {
		return nil
	}

	contactIDs := map[int]struct{}{}
	userIDs := map[int]struct{}{}
	for i := range tt {
		if tt[i].ContactID != nil {
			contactIDs[*tt[i].ContactID] = struct{}{}
		}
		if tt[i].UserID != nil {
			userIDs[*tt[i].UserID] = struct{}{}
		}
	}
	if len(contactIDs) == 0 && len(userIDs) == 0 {
		return nil
	}

	tenantID := tt[0].TenantID
	cids := make([]int, 0, len(contactIDs))
	for id := range contactIDs {
		cids = append(cids, id)
	}
	uids := make([]int, 0, len(userIDs))
	for id := range userIDs {
		uids = append(uids, id)
	}

	contacts, err := s.repo.GetContactSummaries(ctx, tenantID, cids)
	if err != nil {
		return err
	}
	users, err := s.repo.GetUserSummaries(ctx, tenantID, uids)
	if err != nil {
		return err
	}

	for i := range tt {
		if tt[i].ContactID != nil {
			if c, ok := contacts[*tt[i].ContactID]; ok {
				c := c // capture range value
				tt[i].Contact = &c
			}
		}
		if tt[i].UserID != nil {
			if u, ok := users[*tt[i].UserID]; ok {
				u := u
				tt[i].User = &u
			}
		}
	}
	return nil
}

func validateTaskCreate(req tasks.CreateTaskRequest) error {
	if strings.TrimSpace(req.Title) == "" {
		return ValidationError{Field: "title", Code: "TITLE_REQUIRED", Message: "title is required"}
	}
	if len(req.Title) > 500 {
		return ValidationError{Field: "title", Code: "TITLE_TOO_LONG", Message: "title must be ≤ 500 characters"}
	}
	if req.Priority != "" && !tasks.ValidatePriority(req.Priority) {
		return ValidationError{Field: "priority", Code: "INVALID_PRIORITY", Message: "priority must be Low, Medium, High or Critical"}
	}
	// dueDate range is validated after parsing in Create.
	return nil
}

func validateTaskUpdate(req tasks.UpdateTaskRequest) error {
	if req.Title != nil && strings.TrimSpace(*req.Title) == "" {
		return ValidationError{Field: "title", Code: "TITLE_REQUIRED", Message: "title cannot be empty"}
	}
	if req.Title != nil && len(*req.Title) > 500 {
		return ValidationError{Field: "title", Code: "TITLE_TOO_LONG", Message: "title must be ≤ 500 characters"}
	}
	if req.Priority != nil && !tasks.ValidatePriority(*req.Priority) {
		return ValidationError{Field: "priority", Code: "INVALID_PRIORITY", Message: "priority must be Low, Medium, High or Critical"}
	}
	if req.Status != nil && !tasks.ValidateStatus(*req.Status) {
		return ValidationError{Field: "status", Code: "INVALID_STATUS", Message: "status must be Pending, In Progress, Completed or Cancelled"}
	}
	return nil
}

func parseDueDate(input string) (*time.Time, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return nil, nil
	}

	if datetimeLocalRE.MatchString(input) {
		loc, err := time.LoadLocation("Asia/Kolkata")
		if err != nil {
			return nil, err
		}
		var layout string
		switch {
		case strings.Contains(input, "."):
			layout = "2006-01-02T15:04:05.999999999"
		case len(input) == 16:
			layout = "2006-01-02T15:04"
		default:
			layout = "2006-01-02T15:04:05"
		}
		t, err := time.ParseInLocation(layout, input, loc)
		if err != nil {
			return nil, err
		}
		if t.Year() < 2000 || t.Year() > 2100 {
			return nil, fmt.Errorf("due date year out of range")
		}
		return &t, nil
	}

	for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
		t, err := time.Parse(layout, input)
		if err == nil {
			if t.Year() < 2000 || t.Year() > 2100 {
				return nil, fmt.Errorf("due date year out of range")
			}
			return &t, nil
		}
	}
	return nil, fmt.Errorf("invalid due date format")
}

func pickAssignee(targetUserID, fallbackUserID int) *int {
	if targetUserID > 0 {
		return &targetUserID
	}
	if fallbackUserID > 0 {
		return &fallbackUserID
	}
	return nil
}

func diffTask(before, after *tasks.Task) map[string]any {
	changes := map[string]any{}
	if before.Title != after.Title {
		changes["title"] = map[string]any{"from": before.Title, "to": after.Title}
	}
	if !ptrStringEqual(before.Notes, after.Notes) {
		changes["notes"] = map[string]any{"from": before.Notes, "to": after.Notes}
	}
	if !ptrTimeEqual(before.DueDate, after.DueDate) {
		changes["dueDate"] = map[string]any{"from": timePtrJSON(before.DueDate), "to": timePtrJSON(after.DueDate)}
	}
	if before.Priority != after.Priority {
		changes["priority"] = map[string]any{"from": before.Priority, "to": after.Priority}
	}
	if before.Status != after.Status {
		changes["status"] = map[string]any{"from": before.Status, "to": after.Status}
	}
	return changes
}

func ptrStringEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func ptrTimeEqual(a, b *time.Time) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return a.Equal(*b)
}

func timePtrJSON(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format(time.RFC3339Nano)
}

// Compile-time interface check.
var _ TaskService = (*taskSvc)(nil)
