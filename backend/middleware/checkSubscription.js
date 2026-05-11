function checkSubscription(req, res, next) {
  const user = req.user;
  const now = new Date();

  if (user.subscriptionStatus === 'TRIAL') {
    if (user.trialEndsAt && now > user.trialEndsAt) {
      // Trial expired
      return res.status(402).json({
        error: 'TRIAL_EXPIRED',
        message: 'Your free trial has expired. Please upgrade to continue.',
        upgradeUrl: '/pricing'
      });
    }
  } else if (user.subscriptionStatus === 'EXPIRED' || user.subscriptionStatus === 'CANCELLED') {
    return res.status(402).json({
      error: 'NO_ACTIVE_SUBSCRIPTION',
      message: 'No active subscription. Please upgrade to continue.',
      upgradeUrl: '/pricing'
    });
  }

  next();
}

module.exports = checkSubscription;
