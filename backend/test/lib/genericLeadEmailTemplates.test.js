const templates = require('../../lib/genericLeadEmailTemplates');
describe('genericLeadEmailTemplates', () => {
  test('uses stable system categories', () => { expect(templates.genericLeadNotificationCategory(true)).toBe('System: Generic CRM: New Lead'); expect(templates.genericLeadNotificationCategory(false)).toBe('System: Generic CRM: Updated Lead'); });
  test('creates four editable defaults once', async () => { const db = { emailTemplate: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async ({ data }) => data) }, tenantSetting: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() } }; expect(await templates.ensureGenericLeadNotificationTemplates(db, 7)).toHaveLength(4); expect(db.tenantSetting.upsert).toHaveBeenCalled(); });
});
