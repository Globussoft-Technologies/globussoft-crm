// Branding Wave 4 — G090: per-sub-brand brand-kit token interpolation for
// outbound emails (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.1.d + FR-3.3.d).
//
// The existing email pipeline (routes/email.js → sendSendGrid +
// cron/scheduledEmailEngine.js → sendViaSendGrid + routes/email_templates.js)
// previously rendered the EmailTemplate / ScheduledEmail body string verbatim.
// This helper sits BEFORE the SendGrid call and replaces brand tokens with
// the resolved BrandKit values for the email's anchor sub-brand. The render
// is shape-preserving for non-token text — callers that don't pass a
// brandKit (or whose body has no tokens) get their input back unchanged.
//
// Token grammar — matches the existing {{name}} / {{company}} convention
// used by services/smsProvider.js substituteVars(). Five branding tokens
// land in this wave:
//   {{brand_logo_url}}           — BrandKit.logoUrl (light)
//   {{brand_primary_color}}      — BrandKit.primaryColor (hex)
//   {{brand_tagline}}            — BrandKit.tagline
//   {{brand_signature_template}} — BrandKit.signatureTemplate (HTML)
//   {{brand_footer_text}}        — BrandKit.footerText
//
// Fallback chain per token (FR-3.3 "If the kit is missing a field, fall back
// to tenant-level default"):
//   1. BrandKit row for (tenantId, subBrand, isActive=true)
//   2. Tenant-wide BrandKit row (subBrand=null, isActive=true)
//   3. Empty string — caller is free to choose its own neutral default.
//
// G097 callers pass `{ tenantId, subBrand, body, subject }`; the helper
// resolves the kit ONCE per call (DB read), caches nothing (the email
// pipeline already batches due rows and the kit-read is sub-ms), and
// returns { renderedBody, renderedSubject }.
//
// Tokens missing from the resolved kit are replaced with empty string so a
// half-populated kit never leaks "{{brand_signature_template}}" into the
// outbound message. This matches the existing substituteVars behaviour
// for {{name}} / {{company}}.
//
// CJS self-mocking seam (CLAUDE.md standing pattern): inter-function calls
// go through module.exports.fn(...) so vitest vi.spyOn interception works.
// resolveBrandKit() is the seam — vitest mocks it instead of stubbing
// the whole prisma client.

const TOKEN_FIELD_MAP = {
  brand_logo_url: "logoUrl",
  brand_primary_color: "primaryColor",
  brand_tagline: "tagline",
  brand_signature_template: "signatureTemplate",
  brand_footer_text: "footerText",
};

const TOKEN_NAMES = Object.keys(TOKEN_FIELD_MAP);

/**
 * Resolve the brand kit for a given (tenantId, subBrand). Tries the
 * sub-brand-scoped active row first; falls back to the tenant-wide row.
 * Returns null when neither exists (caller renders with empty tokens).
 *
 * @param {object} prisma - shared Prisma client (passed in to keep this
 *   helper pure-ish and easy to unit-test without bootstrapping prisma)
 * @param {number} tenantId
 * @param {string|null|undefined} subBrand - tmc | rfu | travelstall | visasure | null
 * @returns {Promise<object|null>} the BrandKit row (or null)
 */
async function resolveBrandKit(prisma, tenantId, subBrand) {
  if (!prisma || !tenantId) return null;
  try {
    if (subBrand) {
      const kit = await prisma.brandKit.findFirst({
        where: { tenantId, subBrand, isActive: true },
      });
      if (kit) return kit;
    }
    // Fall back to the tenant-wide row (subBrand=null).
    const fallback = await prisma.brandKit.findFirst({
      where: { tenantId, subBrand: null, isActive: true },
    });
    return fallback || null;
  } catch (e) {
    // Defensive: never let a brand-kit resolve crash a send. The caller's
    // render path already tolerates a null kit gracefully.
    console.warn(`[emailRender] brand-kit resolve failed (rendering with empty tokens): ${e.message}`);
    return null;
  }
}

/**
 * Build the token → value substitution map from a BrandKit row. Missing
 * fields fall back to empty string so partial kits never leak the raw
 * `{{brand_signature_template}}` literal into the wire payload.
 *
 * @param {object|null} brandKit
 * @returns {Record<string, string>}
 */
function buildTokenMap(brandKit) {
  const out = {};
  for (const token of TOKEN_NAMES) {
    const field = TOKEN_FIELD_MAP[token];
    const value = brandKit && brandKit[field] != null ? brandKit[field] : "";
    out[token] = String(value);
  }
  return out;
}

/**
 * Replace every {{token}} occurrence in the input string with its
 * resolved value. Unknown tokens (e.g. {{name}} from the existing
 * variable system, or a typo like {{brand_foo}}) are left UNTOUCHED so
 * downstream substitution layers (substituteVars / template-engine
 * placeholders) still get a chance to render them.
 *
 * @param {string} text
 * @param {Record<string, string>} tokenMap
 * @returns {string}
 */
function applyTokens(text, tokenMap) {
  if (text == null) return "";
  let out = String(text);
  for (const token of TOKEN_NAMES) {
    // Use a per-token regex so we only consume tokens we know how to
    // render — keeps the {{name}} / {{company}} / etc. substitution
    // chain in services/smsProvider.js + email_templates.js intact.
    const re = new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, "g");
    out = out.replace(re, tokenMap[token]);
  }
  return out;
}

/**
 * Render an email body + subject with brand tokens interpolated.
 *
 * @param {object} args
 * @param {object} args.prisma                — Prisma client
 * @param {number} args.tenantId              — required for kit resolution
 * @param {string|null|undefined} args.subBrand — anchor sub-brand (G097
 *   resolves this from Deal/Invoice/Contact at send time)
 * @param {string} args.body                  — raw email body (may contain tokens)
 * @param {string} [args.subject]             — optional subject (also tokenised)
 * @returns {Promise<{renderedBody: string, renderedSubject: string, brandKit: object|null}>}
 */
async function renderEmailWithBrand({ prisma, tenantId, subBrand, body, subject }) {
  const brandKit = await module.exports.resolveBrandKit(prisma, tenantId, subBrand);
  const tokenMap = buildTokenMap(brandKit);
  return {
    renderedBody: applyTokens(body, tokenMap),
    renderedSubject: applyTokens(subject || "", tokenMap),
    brandKit,
  };
}

module.exports = {
  renderEmailWithBrand,
  resolveBrandKit,
  buildTokenMap,
  applyTokens,
  TOKEN_FIELD_MAP,
  TOKEN_NAMES,
};
