package services

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/tasks"
	"github.com/stretchr/testify/assert"
)

type mockTaskRepo struct {
	list             func(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error)
	getByID          func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error)
	create           func(ctx context.Context, task *tasks.Task) error
	update           func(ctx context.Context, task *tasks.Task) error
	softDelete       func(ctx context.Context, id, tenantID int) error
	restore          func(ctx context.Context, id, tenantID int) error
	contactSummaries func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error)
	userSummaries    func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error)
}

func (m *mockTaskRepo) List(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error) {
	if m.list != nil {
		return m.list(ctx, p)
	}
	return nil, 0, nil
}

func (m *mockTaskRepo) GetByID(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
	if m.getByID != nil {
		return m.getByID(ctx, id, tenantID, includeDeleted)
	}
	return nil, nil
}

func (m *mockTaskRepo) Create(ctx context.Context, task *tasks.Task) error {
	if m.create != nil {
		return m.create(ctx, task)
	}
	return nil
}

func (m *mockTaskRepo) Update(ctx context.Context, task *tasks.Task) error {
	if m.update != nil {
		return m.update(ctx, task)
	}
	return nil
}

func (m *mockTaskRepo) SoftDelete(ctx context.Context, id, tenantID int) error {
	if m.softDelete != nil {
		return m.softDelete(ctx, id, tenantID)
	}
	return nil
}

func (m *mockTaskRepo) Restore(ctx context.Context, id, tenantID int) error {
	if m.restore != nil {
		return m.restore(ctx, id, tenantID)
	}
	return nil
}

func (m *mockTaskRepo) GetContactSummaries(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error) {
	if m.contactSummaries != nil {
		return m.contactSummaries(ctx, tenantID, ids)
	}
	return map[int]tasks.ContactSummary{}, nil
}

func (m *mockTaskRepo) GetUserSummaries(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error) {
	if m.userSummaries != nil {
		return m.userSummaries(ctx, tenantID, ids)
	}
	return map[int]tasks.UserSummary{}, nil
}

func TestTaskService_Create_Success(t *testing.T) {
	repo := &mockTaskRepo{
		create: func(ctx context.Context, task *tasks.Task) error {
			assert.Equal(t, "Call lead", task.Title)
			assert.Equal(t, "Medium", task.Priority)
			assert.Equal(t, "Pending", task.Status)
			task.ID = 42
			return nil
		},
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return &tasks.Task{ID: 42, Title: "Call lead", Status: "Pending", Priority: "Medium", TenantID: 1}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, err := svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "Call lead"})
	assert.NoError(t, err)
	assert.Equal(t, 42, task.ID)
	assert.Equal(t, "Medium", task.Priority)
}

func TestTaskService_Create_AssigneeFallback(t *testing.T) {
	repo := &mockTaskRepo{
		create: func(ctx context.Context, task *tasks.Task) error {
			assert.NotNil(t, task.UserID)
			assert.Equal(t, 7, *task.UserID)
			task.ID = 1
			return nil
		},
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			uid := 7
			return &tasks.Task{ID: 1, Title: "T", TenantID: 1, UserID: &uid}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, err := svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "T", UserID: 7})
	assert.NoError(t, err)
	assert.Equal(t, 7, *task.UserID)
}

func TestTaskService_Create_ValidationErrors(t *testing.T) {
	svc := NewTaskService(&mockTaskRepo{}, noopExecer{})

	_, err := svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: ""})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "TITLE_REQUIRED", err.(ValidationError).Code)

	_, err = svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "T", Priority: "Urgent"})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_PRIORITY", err.(ValidationError).Code)

	_, err = svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "T", DueDate: "not-a-date"})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_DUEDATE", err.(ValidationError).Code)

	_, err = svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "T", DueDate: "1800-01-01T10:00"})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_DUEDATE", err.(ValidationError).Code)
}

func TestTaskService_Create_DueDateDatetimeLocal(t *testing.T) {
	repo := &mockTaskRepo{
		create: func(ctx context.Context, task *tasks.Task) error {
			assert.NotNil(t, task.DueDate)
			// 2026-07-27T10:00 in Asia/Kolkata is 04:30 UTC.
			assert.Equal(t, 2026, task.DueDate.Year())
			assert.Equal(t, 7, int(task.DueDate.Month()))
			assert.Equal(t, 27, task.DueDate.Day())
			assert.Equal(t, 4, task.DueDate.UTC().Hour())
			assert.Equal(t, 30, task.DueDate.UTC().Minute())
			task.ID = 1
			return nil
		},
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return &tasks.Task{ID: 1, Title: "T", TenantID: 1}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, err := svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "T", DueDate: "2026-07-27T10:00"})
	assert.NoError(t, err)
	assert.Equal(t, 1, task.ID)
}

func TestTaskService_Create_DueDateRFC3339(t *testing.T) {
	repo := &mockTaskRepo{
		create: func(ctx context.Context, task *tasks.Task) error {
			assert.NotNil(t, task.DueDate)
			assert.Equal(t, 2026, task.DueDate.Year())
			task.ID = 1
			return nil
		},
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return &tasks.Task{ID: 1, Title: "T", TenantID: 1}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, err := svc.Create(context.Background(), 1, 1, tasks.CreateTaskRequest{Title: "T", DueDate: "2026-07-27T10:00:00Z"})
	assert.NoError(t, err)
	assert.Equal(t, 1, task.ID)
}

func TestTaskService_Update_Success(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
		update: func(ctx context.Context, task *tasks.Task) error {
			existing = task
			return nil
		},
		contactSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error) {
			return map[int]tasks.ContactSummary{}, nil
		},
		userSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error) {
			return map[int]tasks.UserSummary{}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	title := "New"
	priority := "High"
	updated, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{Title: &title, Priority: &priority})
	assert.NoError(t, err)
	assert.Equal(t, "New", updated.Title)
	assert.Equal(t, "High", updated.Priority)
}

func TestTaskService_Update_ClearDueDate(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1, DueDate: &time.Time{}}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
		update: func(ctx context.Context, task *tasks.Task) error {
			existing = task
			return nil
		},
		contactSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error) {
			return map[int]tasks.ContactSummary{}, nil
		},
		userSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error) {
			return map[int]tasks.UserSummary{}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	updated, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{DueDate: []byte("null")})
	assert.NoError(t, err)
	assert.Nil(t, updated.DueDate)
}

func TestTaskService_Update_InvalidDueDate(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	_, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{DueDate: []byte(`"2999-01-01"`)})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_DUEDATE", err.(ValidationError).Code)
}

func TestTaskService_Update_DueDateDatetimeLocal(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
		update: func(ctx context.Context, task *tasks.Task) error {
			existing = task
			return nil
		},
		contactSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error) {
			return map[int]tasks.ContactSummary{}, nil
		},
		userSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error) {
			return map[int]tasks.UserSummary{}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	updated, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{DueDate: []byte(`"2026-07-27T10:00"`)})
	assert.NoError(t, err)
	assert.NotNil(t, updated.DueDate)
	assert.Equal(t, 2026, updated.DueDate.Year())
	assert.Equal(t, 7, int(updated.DueDate.Month()))
	assert.Equal(t, 27, updated.DueDate.Day())
	assert.Equal(t, 4, updated.DueDate.UTC().Hour())
	assert.Equal(t, 30, updated.DueDate.UTC().Minute())
}

func TestTaskService_Update_NoChange(t *testing.T) {
	now := time.Now()
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1, DueDate: &now}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	updated, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{})
	assert.NoError(t, err)
	assert.Equal(t, "Old", updated.Title)
	assert.Equal(t, "Pending", updated.Status)
	assert.Equal(t, "Medium", updated.Priority)
	assert.Equal(t, &now, updated.DueDate)
}

func TestTaskService_Update_InvalidStatus(t *testing.T) {
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	status := "Unknown"
	_, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{Status: &status})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_STATUS", err.(ValidationError).Code)
}

func TestTaskService_Update_NotFound(t *testing.T) {
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return nil, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	title := "New"
	_, err := svc.Update(context.Background(), 1, 1, 5, tasks.UpdateTaskRequest{Title: &title})
	assert.Equal(t, sql.ErrNoRows, err)
}

func TestTaskService_Complete_Transition(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", Priority: "Medium", TenantID: 1}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
		update: func(ctx context.Context, task *tasks.Task) error {
			existing = task
			return nil
		},
		contactSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.ContactSummary, error) {
			return map[int]tasks.ContactSummary{}, nil
		},
		userSummaries: func(ctx context.Context, tenantID int, ids []int) (map[int]tasks.UserSummary, error) {
			return map[int]tasks.UserSummary{}, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, idempotent, err := svc.Complete(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.False(t, idempotent)
	assert.Equal(t, "Completed", task.Status)
}

func TestTaskService_Complete_Idempotent(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Completed", Priority: "Medium", TenantID: 1}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, idempotent, err := svc.Complete(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.True(t, idempotent)
	assert.Equal(t, "Completed", task.Status)
}

func TestTaskService_Delete_Success(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", TenantID: 1}
	calls := 0
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
		softDelete: func(ctx context.Context, id, tenantID int) error {
			calls++
			return nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, idempotent, err := svc.Delete(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.False(t, idempotent)
	assert.Equal(t, 1, calls)
	assert.NotNil(t, task.DeletedAt)
}

func TestTaskService_Delete_Idempotent(t *testing.T) {
	now := time.Now()
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", TenantID: 1, DeletedAt: &now}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, idempotent, err := svc.Delete(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.True(t, idempotent)
	assert.NotNil(t, task.DeletedAt)
}

func TestTaskService_Restore_Success(t *testing.T) {
	now := time.Now()
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", TenantID: 1, DeletedAt: &now}
	calls := 0
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
		restore: func(ctx context.Context, id, tenantID int) error {
			calls++
			return nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, idempotent, err := svc.Restore(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.False(t, idempotent)
	assert.Equal(t, 1, calls)
	assert.Nil(t, task.DeletedAt)
}

func TestTaskService_Restore_Idempotent(t *testing.T) {
	existing := &tasks.Task{ID: 5, Title: "Old", Status: "Pending", TenantID: 1}
	repo := &mockTaskRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*tasks.Task, error) {
			return existing, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	task, idempotent, err := svc.Restore(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.True(t, idempotent)
	assert.Nil(t, task.DeletedAt)
}

func TestTaskService_List_Params(t *testing.T) {
	repo := &mockTaskRepo{
		list: func(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error) {
			assert.Equal(t, 2, p.TenantID)
			assert.Equal(t, "Pending", p.Status)
			assert.Equal(t, "High", p.Priority)
			assert.Equal(t, 10, p.ContactID)
			assert.True(t, p.Overdue)
			assert.True(t, p.Mine)
			assert.True(t, p.IncludeDeleted)
			assert.Equal(t, 50, p.Limit)
			assert.Equal(t, 10, p.Offset)
			assert.Equal(t, "ADMIN", p.CallerRole)
			assert.Equal(t, 7, p.CallerUserID)
			return []tasks.Task{{ID: 1, Title: "T", Priority: "High", CreatedAt: time.Now()}}, 1, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	_, total, err := svc.List(context.Background(), 2, tasks.ListParams{
		Status: "Pending", Priority: "High", ContactID: 10, Overdue: true, Mine: true,
		IncludeDeleted: true, Limit: 50, Offset: 10, CallerRole: "ADMIN", CallerUserID: 7,
	})
	assert.NoError(t, err)
	assert.Equal(t, 1, total)
}

func TestTaskService_List_Count(t *testing.T) {
	repo := &mockTaskRepo{
		list: func(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error) {
			assert.True(t, p.Count)
			return nil, 42, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	tt, total, err := svc.List(context.Background(), 1, tasks.ListParams{Count: true})
	assert.NoError(t, err)
	assert.Nil(t, tt)
	assert.Equal(t, 42, total)
}

func TestTaskService_List_PrioritySort(t *testing.T) {
	now := time.Now()
	repo := &mockTaskRepo{
		list: func(ctx context.Context, p tasks.ListParams) ([]tasks.Task, int, error) {
			return []tasks.Task{
				{ID: 1, Title: "Low", Priority: "Low", CreatedAt: now},
				{ID: 2, Title: "Critical", Priority: "Critical", CreatedAt: now.Add(-time.Hour)},
				{ID: 3, Title: "High", Priority: "High", CreatedAt: now.Add(time.Hour)},
			}, 3, nil
		},
	}
	svc := NewTaskService(repo, noopExecer{})
	tt, _, err := svc.List(context.Background(), 1, tasks.ListParams{})
	assert.NoError(t, err)
	assert.Equal(t, "Critical", tt[0].Priority)
	assert.Equal(t, "High", tt[1].Priority)
	assert.Equal(t, "Low", tt[2].Priority)
}
