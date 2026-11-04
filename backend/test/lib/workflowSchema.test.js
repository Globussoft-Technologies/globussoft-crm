import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const workflowSchema = requireCJS('../../lib/workflowSchema');

describe('workflowSchema Generic CRM fields', () => {
  it('returns the complete module catalog only for generic tenants', () => {
    const generic = workflowSchema.fieldsForVertical('generic');
    const wellness = workflowSchema.fieldsForVertical('wellness');

    expect(generic.contact.map((field) => field.value)).toContain('lifecycleStageKey');
    expect(generic.deal.map((field) => field.value)).toContain('pipelineId');
    expect(generic.task.map((field) => field.value)).toContain('projectId');
    expect(generic.ticket.map((field) => field.value)).toContain('slaResolveDue');
    expect(generic.invoice.map((field) => field.value)).toContain('nextRecurDate');
    expect(generic.payment.map((field) => field.value)).toContain('plotPaymentReference');
    expect(generic.lead.map((field) => field.value)).toContain('whatsappPhone');
    expect(generic.approval.map((field) => field.value)).toContain('approvedAt');

    expect(wellness).toBe(workflowSchema.FIELD_OPTIONS);
    expect(wellness.contact.map((field) => field.value)).not.toContain('lifecycleStageKey');
  });

  it('does not expose system, secret, or vertical-only contact columns', () => {
    const fields = workflowSchema.fieldsForVertical('generic').contact.map((field) => field.value);

    expect(fields).not.toEqual(expect.arrayContaining([
      'tenantId', 'deletedAt', 'portalPasswordHash', 'externalPayloadJson',
      'aadhaarLast4', 'kycTokenId', 'preferredPractitionerId',
    ]));
  });
});
