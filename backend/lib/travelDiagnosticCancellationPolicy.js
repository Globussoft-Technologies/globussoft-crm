/**
 * Cancellation-policy display resolver for diagnostic reports (additive,
 * 2026-08-24; extracted to a shared lib 2026-08-27 so both the public
 * report route AND the customer-portal diagnostic route can reuse it).
 *
 * The show/hide toggle and chosen policy id live inside
 * TravelDiagnosticPublicForm's existing stylingConfigJson catch-all field
 * (see schema.prisma), not a new column — this is a read-only lookup
 * against data the admin panel already saves via its normal "Save
 * settings" flow. Never throws — absence of a form/policy just means the
 * caller renders without one.
 */

const prisma = require("./prisma");

async function resolveCancellationPolicyForForm({ tenantId, subBrand }) {
  try {
    const publicForm = await prisma.travelDiagnosticPublicForm.findUnique({
      where: { tenantId_subBrand: { tenantId, subBrand } },
      select: { stylingConfigJson: true },
    });
    const styling = publicForm?.stylingConfigJson ? JSON.parse(publicForm.stylingConfigJson) : {};
    if (!styling?.showCancellationPolicy || !styling?.cancellationPolicyId) return null;
    const policy = await prisma.cancellationPolicy.findFirst({
      where: { id: Number(styling.cancellationPolicyId), tenantId, isActive: true },
      select: { id: true, name: true, description: true, tiersJson: true },
    });
    if (!policy) return null;
    let tiers = [];
    try {
      tiers = JSON.parse(policy.tiersJson || "[]");
    } catch {
      tiers = [];
    }
    return { id: policy.id, name: policy.name, description: policy.description || null, tiers };
  } catch (e) {
    console.warn("[cancellationPolicy] resolve failed (non-fatal):", e.message);
    return null;
  }
}

module.exports = { resolveCancellationPolicyForForm };
