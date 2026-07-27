package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/tasks"
)

// TaskRepository defines data access for tasks.
type TaskRepository interface {
	List(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error)
	GetByID(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error)
	Create(ctx context.Context, t *tasks.Task) error
	Update(ctx context.Context, t *tasks.Task) error
	SoftDelete(ctx context.Context, id, tenantID int) error
	Restore(ctx context.Context, id, tenantID int) error
	GetContactSummaries(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error)
	GetUserSummaries(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error)
}

type taskRepo struct {
	db *DB
}

// NewTaskRepository returns a TaskRepository backed by database/sql.
func NewTaskRepository(db *DB) TaskRepository {
	return &taskRepo{db: db}
}

const taskColumns = `
	t.id, t.title, t.dueDate, t.status, t.priority, t.notes, t.createdAt, t.deletedAt,
	t.tenantId, t.contactId, t.userId, t.projectId
`

func (r *taskRepo) List(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error) {
	where, args := r.buildWhere(p)
	whereSQL := strings.Join(where, " AND ")

	var total int
	countQuery := "SELECT COUNT(*) FROM Task t WHERE " + whereSQL
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("task count query: %w", err)
	}

	if p.Count {
		return nil, total, nil
	}

	limit := p.Limit
	if limit < 1 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	offset := p.Offset
	if offset < 0 {
		offset = 0
	}

	query := fmt.Sprintf(`
		SELECT %s
		FROM Task t
		WHERE %s
		ORDER BY t.createdAt DESC
		LIMIT ? OFFSET ?`, taskColumns, whereSQL)
	args = append(args, limit, offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("task list query: %w", err)
	}
	defer rows.Close()

	var result []tasks.Task
	for rows.Next() {
		var t tasks.Task
		if err := scanTask(rows, &t); err != nil {
			return nil, 0, fmt.Errorf("task list scan: %w", err)
		}
		result = append(result, t)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("task list rows: %w", err)
	}
	return result, total, nil
}

func (r *taskRepo) buildWhere(p tasks.ListParams) ([]string, []any) {
	where := []string{"t.tenantId = ?"}
	args := []any{p.TenantID}

	if !p.IncludeDeleted {
		where = append(where, "t.deletedAt IS NULL")
	}
	if p.Status != "" {
		where = append(where, "t.status = ?")
		args = append(args, p.Status)
	}
	if p.Priority != "" {
		where = append(where, "t.priority = ?")
		args = append(args, p.Priority)
	}
	if p.ContactID > 0 {
		where = append(where, "t.contactId = ?")
		args = append(args, p.ContactID)
	}
	if p.Overdue {
		where = append(where, "t.dueDate < NOW() AND t.status = 'Pending'")
	}
	if p.Mine {
		if p.CallerRole == "ADMIN" || p.CallerRole == "MANAGER" || p.CallerRole == "OWNER" {
			where = append(where, "(t.userId = ? OR t.userId IS NULL)")
		} else {
			where = append(where, "t.userId = ?")
		}
		args = append(args, p.CallerUserID)
	}
	return where, args
}

func (r *taskRepo) GetByID(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
	where := []string{"t.id = ?", "t.tenantId = ?"}
	args := []any{id, tenantID}
	if !includeDeleted {
		where = append(where, "t.deletedAt IS NULL")
	}

	query := fmt.Sprintf(`
		SELECT %s
		FROM Task t
		WHERE %s`, taskColumns, strings.Join(where, " AND "))

	row := r.db.QueryRowContext(ctx, query, args...)
	var t tasks.Task
	if err := scanTask(row, &t); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("task get by id: %w", err)
	}
	return &t, nil
}

func (r *taskRepo) Create(ctx context.Context, t *tasks.Task) error {
	query := `
		INSERT INTO Task (
			title, dueDate, status, priority, notes, tenantId, contactId, userId, projectId
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	res, err := r.db.ExecContext(ctx, query,
		t.Title, t.DueDate, t.Status, t.Priority, t.Notes, t.TenantID, t.ContactID, t.UserID, t.ProjectID,
	)
	if err != nil {
		return fmt.Errorf("task create: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("task create last id: %w", err)
	}
	t.ID = int(id)
	return nil
}

func (r *taskRepo) Update(ctx context.Context, t *tasks.Task) error {
	set := []string{}
	args := []any{}

	add := func(col string, v any) {
		set = append(set, col+" = ?")
		args = append(args, v)
	}

	add("title", t.Title)
	add("dueDate", t.DueDate)
	add("status", t.Status)
	add("priority", t.Priority)
	add("notes", t.Notes)
	add("contactId", t.ContactID)
	add("userId", t.UserID)
	add("projectId", t.ProjectID)

	if len(set) == 0 {
		return nil
	}

	args = append(args, t.ID, t.TenantID)
	query := fmt.Sprintf("UPDATE Task SET %s WHERE id = ? AND tenantId = ?", strings.Join(set, ", "))
	if _, err := r.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("task update: %w", err)
	}
	return nil
}

func (r *taskRepo) SoftDelete(ctx context.Context, id, tenantID int) error {
	res, err := r.db.ExecContext(ctx,
		"UPDATE Task SET deletedAt = ? WHERE id = ? AND tenantId = ? AND deletedAt IS NULL",
		time.Now(), id, tenantID)
	if err != nil {
		return fmt.Errorf("task soft delete: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *taskRepo) Restore(ctx context.Context, id, tenantID int) error {
	res, err := r.db.ExecContext(ctx,
		"UPDATE Task SET deletedAt = NULL WHERE id = ? AND tenantId = ? AND deletedAt IS NOT NULL",
		id, tenantID)
	if err != nil {
		return fmt.Errorf("task restore: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *taskRepo) GetContactSummaries(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error) {
	if len(ids) == 0 {
		return map[int]tasks.ContactSummary{}, nil
	}
	query := fmt.Sprintf(
		"SELECT id, name, email, phone, company FROM Contact WHERE tenantId = ? AND id IN (%s)",
		inPlaceholders(len(ids)))
	args := append([]any{tenantID}, intsToAny(ids)...)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("task contact summaries: %w", err)
	}
	defer rows.Close()

	result := map[int]tasks.ContactSummary{}
	for rows.Next() {
		var s tasks.ContactSummary
		var email, phone, company sql.NullString
		if err := rows.Scan(&s.ID, &s.Name, &email, &phone, &company); err != nil {
			return nil, fmt.Errorf("task contact summary scan: %w", err)
		}
		s.Email = nullStringPtr(email)
		s.Phone = nullStringPtr(phone)
		s.Company = nullStringPtr(company)
		result[s.ID] = s
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("task contact summary rows: %w", err)
	}
	return result, nil
}

func (r *taskRepo) GetUserSummaries(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error) {
	if len(ids) == 0 {
		return map[int]tasks.UserSummary{}, nil
	}
	query := fmt.Sprintf(
		"SELECT id, name, email, role, profilePicture FROM `User` WHERE tenantId = ? AND id IN (%s)",
		inPlaceholders(len(ids)))
	args := append([]any{tenantID}, intsToAny(ids)...)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("task user summaries: %w", err)
	}
	defer rows.Close()

	result := map[int]tasks.UserSummary{}
	for rows.Next() {
		var s tasks.UserSummary
		var profilePicture sql.NullString
		if err := rows.Scan(&s.ID, &s.Name, &s.Email, &s.Role, &profilePicture); err != nil {
			return nil, fmt.Errorf("task user summary scan: %w", err)
		}
		s.ProfilePicture = nullStringPtr(profilePicture)
		result[s.ID] = s
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("task user summary rows: %w", err)
	}
	return result, nil
}

func scanTask(s scanner, t *tasks.Task) error {
	var title, status, priority sql.NullString
	var notes sql.NullString
	var dueDate, createdAt, deletedAt sql.NullTime
	var contactID, userID, projectID sql.NullInt64

	err := s.Scan(
		&t.ID, &title, &dueDate, &status, &priority, &notes, &createdAt, &deletedAt,
		&t.TenantID, &contactID, &userID, &projectID,
	)
	if err != nil {
		return err
	}

	t.Title = title.String
	t.Status = status.String
	t.Priority = priority.String
	t.Notes = nullStringPtr(notes)
	t.DueDate = nullTimePtr(dueDate)
	t.CreatedAt = createdAt.Time
	t.DeletedAt = nullTimePtr(deletedAt)
	t.ContactID = nullIntPtr(contactID)
	t.UserID = nullIntPtr(userID)
	t.ProjectID = nullIntPtr(projectID)
	return nil
}

func inPlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

func intsToAny(ids []int) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}

// Compile-time interface check.
var _ TaskRepository = (*taskRepo)(nil)
