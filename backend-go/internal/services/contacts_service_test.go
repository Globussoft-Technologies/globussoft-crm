package services

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/domain/contacts"
	"github.com/stretchr/testify/assert"
)

type mockContactRepo struct {
	list    func(ctx context.Context, p contacts.ListParams) ([]contacts.Contact, int, error)
	getByID func(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error)
	create  func(ctx context.Context, c *contacts.Contact) error
	update  func(ctx context.Context, c *contacts.Contact) error
	delete  func(ctx context.Context, id, tenantID int) error
	restore func(ctx context.Context, id, tenantID int) error
}

func (m *mockContactRepo) List(ctx context.Context, p contacts.ListParams) ([]contacts.Contact, int, error) {
	if m.list != nil {
		return m.list(ctx, p)
	}
	return nil, 0, nil
}

func (m *mockContactRepo) GetByID(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
	if m.getByID != nil {
		return m.getByID(ctx, id, tenantID, includeDeleted)
	}
	return nil, nil
}

func (m *mockContactRepo) Create(ctx context.Context, c *contacts.Contact) error {
	if m.create != nil {
		return m.create(ctx, c)
	}
	return nil
}

func (m *mockContactRepo) Update(ctx context.Context, c *contacts.Contact) error {
	if m.update != nil {
		return m.update(ctx, c)
	}
	return nil
}

func (m *mockContactRepo) SoftDelete(ctx context.Context, id, tenantID int) error {
	if m.delete != nil {
		return m.delete(ctx, id, tenantID)
	}
	return nil
}

func (m *mockContactRepo) Restore(ctx context.Context, id, tenantID int) error {
	if m.restore != nil {
		return m.restore(ctx, id, tenantID)
	}
	return nil
}

type noopExecer struct{}

func (n noopExecer) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return nil, nil
}

func TestContactService_Create_Success(t *testing.T) {
	repo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error {
			assert.Equal(t, "Acme", c.Name)
			assert.Equal(t, "Lead", c.Status)
			c.ID = 42
			return nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	email := "acme@example.com"
	contact, err := svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "Acme", Email: &email})
	assert.NoError(t, err)
	assert.Equal(t, 42, contact.ID)
	assert.Equal(t, "Lead", contact.Status)
	assert.Equal(t, 1, *contact.AssignedToID)
}

func TestContactService_Create_ValidationErrors(t *testing.T) {
	svc := NewContactService(&mockContactRepo{}, noopExecer{})

	_, err := svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: ""})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "NAME_REQUIRED", err.(ValidationError).Code)

	_, err = svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "A"})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "EMAIL_REQUIRED", err.(ValidationError).Code)

	badEmail := "not-an-email"
	_, err = svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "A", Email: &badEmail})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_EMAIL", err.(ValidationError).Code)

	badStatus := "Unknown"
	email := "a@example.com"
	_, err = svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "A", Email: &email, Status: badStatus})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_STATUS", err.(ValidationError).Code)

	badScore := 101
	_, err = svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "A", Email: &email, AIScore: badScore})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_AISCORE", err.(ValidationError).Code)
}

func TestContactService_Update_Success(t *testing.T) {
	contact := &contacts.Contact{ID: 5, Name: "Old", Status: "Lead", TenantID: 1}
	repo := &mockContactRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
			return contact, nil
		},
		update: func(ctx context.Context, c *contacts.Contact) error {
			contact = c
			return nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	name := "New"
	status := "Prospect"
	updated, err := svc.Update(context.Background(), 1, 1, 5, contacts.UpdateContactRequest{Name: &name, Status: &status})
	assert.NoError(t, err)
	assert.Equal(t, "New", updated.Name)
	assert.Equal(t, "Prospect", updated.Status)
}

func TestContactService_Update_NotFound(t *testing.T) {
	repo := &mockContactRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
			return nil, nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	name := "New"
	_, err := svc.Update(context.Background(), 1, 1, 5, contacts.UpdateContactRequest{Name: &name})
	assert.Equal(t, sql.ErrNoRows, err)
}

func TestContactService_Delete_Success(t *testing.T) {
	repo := &mockContactRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
			return &contacts.Contact{ID: 5, Name: "Jane", TenantID: 1}, nil
		},
		delete: func(ctx context.Context, id, tenantID int) error {
			return nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	contact, err := svc.Delete(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.Equal(t, 5, contact.ID)
	assert.NotNil(t, contact.DeletedAt)
}

func TestContactService_Restore_Success(t *testing.T) {
	now := time.Now()
	repo := &mockContactRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
			return &contacts.Contact{ID: 5, Name: "Jane", TenantID: 1, DeletedAt: &now}, nil
		},
		restore: func(ctx context.Context, id, tenantID int) error {
			return nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	contact, err := svc.Restore(context.Background(), 1, 1, 5)
	assert.NoError(t, err)
	assert.Equal(t, 5, contact.ID)
	assert.Nil(t, contact.DeletedAt)
}

func TestContactService_List_Params(t *testing.T) {
	repo := &mockContactRepo{
		list: func(ctx context.Context, p contacts.ListParams) ([]contacts.Contact, int, error) {
			assert.Equal(t, 2, p.TenantID)
			assert.Equal(t, "Customer", p.Status)
			assert.Equal(t, "globus", p.Search)
			assert.True(t, p.IncludeDeleted)
			assert.Equal(t, 2, p.Page)
			assert.Equal(t, 50, p.PageSize)
			return []contacts.Contact{{ID: 1, Name: "Globus"}}, 1, nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	contactsList, total, err := svc.List(context.Background(), 2, contacts.ListParams{
		Status: "Customer", Search: "globus", IncludeDeleted: true, Page: 2, PageSize: 50,
	})
	assert.NoError(t, err)
	assert.Equal(t, 1, total)
	assert.Len(t, contactsList, 1)
}

func TestContactService_GetByID(t *testing.T) {
	repo := &mockContactRepo{
		getByID: func(ctx context.Context, id, tenantID int, includeDeleted bool) (*contacts.Contact, error) {
			assert.True(t, includeDeleted)
			return &contacts.Contact{ID: 10, Name: "Hidden"}, nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	contact, err := svc.GetByID(context.Background(), 1, 10, true)
	assert.NoError(t, err)
	assert.Equal(t, 10, contact.ID)
}

func TestContactService_ValidateGST(t *testing.T) {
	repo := &mockContactRepo{
		create: func(ctx context.Context, c *contacts.Contact) error {
			c.ID = 1
			return nil
		},
	}
	svc := NewContactService(repo, noopExecer{})
	email := "a@example.com"
	validGST := "27AABCU9603R1ZM"
	_, err := svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "A", Email: &email, GST: &validGST})
	assert.NoError(t, err)

	invalidGST := "bad"
	_, err = svc.Create(context.Background(), 1, 1, contacts.CreateContactRequest{Name: "A", Email: &email, GST: &invalidGST})
	assert.IsType(t, ValidationError{}, err)
	assert.Equal(t, "INVALID_GST", err.(ValidationError).Code)
}
