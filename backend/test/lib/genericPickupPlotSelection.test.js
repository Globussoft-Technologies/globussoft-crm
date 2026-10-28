const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config/secrets');
const selection = require('../../lib/genericPickupPlotSelection');
describe('genericPickupPlotSelection', () => {
  test('round-trips a purpose-bound token and builds its URL', () => { const token = selection.createSelectionToken({ tenantId: 7, contactId: 61, submissionId: 5 }); expect(selection.verifySelectionToken(token)).toEqual(expect.objectContaining({ tenantId: 7, contactId: 61, submissionId: 5 })); expect(selection.selectionUrl({ baseUrl: 'https://crm.example.com/', token })).toBe(`https://crm.example.com/pickup-plot-selection/${token}`); });
  test('rejects another JWT purpose', () => { const token = jwt.sign({ purpose: 'other', tenantId: 7, contactId: 61 }, JWT_SECRET); expect(() => selection.verifySelectionToken(token)).toThrow('Invalid selection-token purpose'); });
});
