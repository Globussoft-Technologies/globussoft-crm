package services

import (
	"context"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
)

// AuditService defines the audit use-case interface.
type AuditService interface {
	List(ctx context.Context, tenantID int, entity, action string, limit int) ([]repository.AuditLog, error)
	Verify(ctx context.Context, tenantID int) (*repository.AuditVerifyResult, error)
}

// auditSvc is the production implementation.
type auditSvc struct {
	repo repository.AuditRepository
}

// NewAuditService returns an AuditService.
func NewAuditService(repo repository.AuditRepository) AuditService {
	return &auditSvc{repo: repo}
}

// List returns audit logs for a tenant.
func (s *auditSvc) List(ctx context.Context, tenantID int, entity, action string, limit int) ([]repository.AuditLog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	return s.repo.List(ctx, repository.AuditListParams{
		TenantID: tenantID,
		Entity:   entity,
		Action:   action,
		Limit:    limit,
	})
}

// Verify runs the tamper-evidence chain check for a tenant.
func (s *auditSvc) Verify(ctx context.Context, tenantID int) (*repository.AuditVerifyResult, error) {
	return s.repo.VerifyChain(ctx, tenantID)
}
