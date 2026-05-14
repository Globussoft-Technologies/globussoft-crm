/**
 * Block CUSTOMER Usertype Middleware
 *
 * Prevents users with userType=CUSTOMER from accessing staff-only routes.
 * CUSTOMER users are allowed only on customer-facing routes (/api/portal/*,
 * /api/wellness/portal/*, etc.) which have their own auth middleware.
 *
 * Usage:
 *   router.use(blockCustomers); // at top of staff-only routers
 */

function blockCustomers(req, res, next) {
  // Allow if no user authenticated
  if (!req.user) {
    return next();
  }

  // Block CUSTOMER usertype
  if (req.user.userType === 'CUSTOMER') {
    return res.status(403).json({
      error: 'Access denied: customers cannot access this endpoint',
      code: 'CUSTOMER_ACCESS_DENIED',
    });
  }

  // Allow STAFF and OWNER
  next();
}

module.exports = { blockCustomers };
