const { ADDON_PRICES, FREE_TIER_EXCLUDED_ADDONS, TIER_ADDON_MULTIPLIERS } = require("../config/pricing");

function isAddonAllowedForTier(tier, addon) {
  return !(tier === "Free" && FREE_TIER_EXCLUDED_ADDONS.includes(addon));
}

function addonPriceForTier(tier, addon) {
  const base = ADDON_PRICES[addon];
  if (base === undefined) return undefined;
  const multiplier = TIER_ADDON_MULTIPLIERS[tier] || 1;
  return Math.ceil(base * multiplier);
}

function addonTotalForTier(tier, addOns) {
  return (addOns || []).reduce((s, a) => s + (isAddonAllowedForTier(tier, a) ? (addonPriceForTier(tier, a) || 0) : 0), 0);
}

// Display-only check ("should we show/offer the discount"). Actually consuming it at booking
// time goes through an atomic findOneAndUpdate instead, so a concurrent double-submit can't
// have both requests pass this check before either one claims it.
function welcomeDiscountEligible(user) {
  return !!(user && user.discountPercent && user.discountExpiresAt && user.discountExpiresAt > new Date() && !user.discountUsed);
}

function calcPercentDiscount(base, percent) {
  return Math.round(base * percent) / 100;
}

module.exports = { isAddonAllowedForTier, addonPriceForTier, addonTotalForTier, welcomeDiscountEligible, calcPercentDiscount };
