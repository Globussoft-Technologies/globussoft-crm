const prisma = require("./prisma");

/**
 * Resolve a coupon code for application/preview inside a tenant.
 *
 * Returns { coupon } on success, or { error, coupon? } on failure.
 * The error shape is { status, code, message } ready to be returned
 * directly from an Express route.
 *
 * tenantId is passed explicitly so callers without a req.user
 * (anonymous public payment flows) can reuse this helper.
 */
async function loadCouponForApply(tenantId, code) {
  const coupon = await prisma.coupon.findFirst({
    where: {
      tenantId,
      code: String(code || "")
        .trim()
        .toUpperCase(),
    },
  });
  if (!coupon)
    return {
      error: {
        status: 404,
        code: "COUPON_NOT_FOUND",
        message: "Coupon not found",
      },
    };
  if (!coupon.isActive)
    return {
      error: {
        status: 409,
        code: "COUPON_INACTIVE",
        message: "Coupon is inactive",
      },
      coupon,
    };
  const now = Date.now();
  if (coupon.validFrom && coupon.validFrom.getTime() > now) {
    return {
      error: {
        status: 409,
        code: "COUPON_NOT_YET_VALID",
        message: "Coupon is not yet valid",
      },
      coupon,
    };
  }
  if (coupon.validUntil && coupon.validUntil.getTime() < now) {
    return {
      error: {
        status: 410,
        code: "COUPON_EXPIRED",
        message: "Coupon has expired",
      },
      coupon,
    };
  }
  if (
    coupon.maxRedemptions != null &&
    coupon.redemptionCount >= coupon.maxRedemptions
  ) {
    return {
      error: {
        status: 409,
        code: "COUPON_LIMIT_REACHED",
        message: "Coupon redemption limit reached",
      },
      coupon,
    };
  }
  return { coupon };
}

module.exports = { loadCouponForApply };
