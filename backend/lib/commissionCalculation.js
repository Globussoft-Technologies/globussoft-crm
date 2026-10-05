const roundMoney = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;

// Returns null when a profile cannot be calculated. Never report zero for a
// missing or incompatible rate: zero means a valid rule found no eligible sales.
function calculateCommission(profile, amounts) {
  if (!profile || profile.isActive === false) return null;
  const percentage = profile.percentage == null ? null : Number(profile.percentage);
  const flatAmount = profile.flatAmount == null ? null : Number(profile.flatAmount);
  if (percentage != null && (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)) return null;
  if (flatAmount != null && (!Number.isFinite(flatAmount) || flatAmount < 0)) return null;

  let commissionableAmount = 0;
  let commission;
  switch (profile.basis) {
    case "REVENUE_PERCENT":
      if (percentage == null) return null;
      commissionableAmount = Math.max(0, amounts.netSales);
      commission = commissionableAmount * percentage / 100;
      break;
    case "PER_SERVICE":
      commissionableAmount = Math.max(0, amounts.serviceRevenue);
      commission = percentage != null
        ? commissionableAmount * percentage / 100
        : flatAmount == null ? null : Math.max(0, amounts.serviceCount) * flatAmount;
      break;
    case "PER_PRODUCT":
      commissionableAmount = Math.max(0, amounts.productRevenue);
      commission = percentage != null
        ? commissionableAmount * percentage / 100
        : flatAmount == null ? null : Math.max(0, amounts.productCount) * flatAmount;
      break;
    case "FLAT_PER_INVOICE":
      if (flatAmount == null) return null;
      commissionableAmount = Math.max(0, amounts.netSales);
      commission = Math.max(0, amounts.invoiceCount) * flatAmount;
      break;
    default:
      return null;
  }
  if (commission == null || !Number.isFinite(commission)) return null;
  return {
    profileId: profile.id,
    profileName: profile.name,
    basis: profile.basis,
    commissionableAmount: roundMoney(commissionableAmount),
    commission: roundMoney(commission),
  };
}

module.exports = { calculateCommission };
