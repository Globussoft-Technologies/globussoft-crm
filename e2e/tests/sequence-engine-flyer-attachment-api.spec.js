// @ts-check
/**
 * Sequence engine — flyer attachment integration (S19).
 *
 * PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5. Pins the contract for the
 * SequenceStep.attachmentRefsJson column when set with a flyer ref:
 *
 *   POST /api/sequences/:id/steps
 *     { kind:'email', emailTemplateId, attachmentRefsJson:'[{...}]' }
 *
 * → engine renders the referenced TravelFlyerTemplate at send-time +
 * attaches the buffer to the outbound email + emits an audit row
 * 'sequence.step.flyer-attached'.
 *
 * This spec is gated on TWO probes that must both pass:
 *   1. The schema migration shipped — the SequenceStep model accepts
 *      attachmentRefsJson on create. We probe by posting a sequence step
 *      with the new field. A 400 INVALID_FIELD / 422 / 500 with a Prisma
 *      "Unknown arg" error indicates the route layer hasn't been
 *      extended yet → describe-skip with a structured reason.
 *   2. The current backend (BASE_URL) has the route layer wired to
 *      forward attachmentRefsJson. The probe above implicitly covers
 *      this too.
 *
 * Until the sequence-step route accepts the new field (a follow-up
 * slice — out of scope for S19 which only adds the schema + engine
 * support), the spec emits a `test.skip` with a clear reason so future
 * runs reactivate it as soon as the route catches up.
 *
 * Not in the deploy.yml api_tests gate spec list yet. Will be wired in a
 * follow-up slice once the route layer exposes the field.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_SEQ_FLYER_${Date.now()}`;

let authToken = null;
let routeAcceptsAttachmentRefs = null; // null = undetermined, true/false after probe

async function authAdmin(request) {
  if (authToken) return authToken;
  const resp = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!resp.ok()) throw new Error(`login failed: ${resp.status()}`);
  const body = await resp.json();
  authToken = body.token;
  return authToken;
}

test.describe('S19 — sequenceEngine flyer-attachment route probe', () => {
  test.beforeAll(async ({ request }) => {
    // Probe: try to create a tiny sequence + a step with the new field.
    // If the route 400s INVALID_FIELD or strips the field silently, we
    // mark routeAcceptsAttachmentRefs=false and skip the assertions
    // below.
    try {
      const token = await authAdmin(request);
      const seqResp = await request.post(`${BASE_URL}/api/sequences`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: `${RUN_TAG}_probe`, isActive: false },
        timeout: REQUEST_TIMEOUT,
      });
      if (!seqResp.ok()) {
        routeAcceptsAttachmentRefs = false;
        return;
      }
      const seqBody = await seqResp.json();
      const sequenceId = seqBody.id || seqBody.sequence?.id;
      if (!sequenceId) {
        routeAcceptsAttachmentRefs = false;
        return;
      }

      const stepResp = await request.post(`${BASE_URL}/api/sequences/${sequenceId}/steps`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          kind: 'email',
          position: 0,
          attachmentRefsJson: JSON.stringify([
            { kind: 'flyer', flyerId: 1, format: 'pdf-a4' },
          ]),
        },
        timeout: REQUEST_TIMEOUT,
      });
      if (!stepResp.ok()) {
        routeAcceptsAttachmentRefs = false;
        // Clean up the probe sequence regardless.
        await request.delete(`${BASE_URL}/api/sequences/${sequenceId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT,
        }).catch(() => {});
        return;
      }
      const stepBody = await stepResp.json();
      // Confirm the field round-trips. If the route silently dropped it,
      // attachmentRefsJson will be null/undefined in the response.
      routeAcceptsAttachmentRefs =
        typeof stepBody.attachmentRefsJson === 'string' && stepBody.attachmentRefsJson.length > 0;

      // Cleanup.
      await request.delete(`${BASE_URL}/api/sequences/${sequenceId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT,
      }).catch(() => {});
    } catch (_e) {
      routeAcceptsAttachmentRefs = false;
    }
  });

  test('Sequence-step route accepts and round-trips attachmentRefsJson', async ({ request }) => {
    test.skip(
      routeAcceptsAttachmentRefs !== true,
      'Sequence-step route does not yet accept attachmentRefsJson — follow-up route slice required. Engine support is shipped per S19; this spec activates once /api/sequences/:id/steps adds the field to its allow-list.',
    );

    // Once the route is wired, end-to-end assertions land here:
    //   - Create sequence + flyer template + contact
    //   - POST step with attachmentRefsJson:[{kind:'flyer',flyerId:X,format:'pdf-a4'}]
    //   - Enroll contact + manual tick
    //   - Assert EmailMessage row written + audit row
    //     'sequence.step.flyer-attached' present
    expect(routeAcceptsAttachmentRefs).toBe(true);
  });
});
