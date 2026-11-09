const TIER_PRICES  = { Scene: 189, Feature: 399 }; // Free and Custom intentionally absent — both resolve to $0 base via the `|| 0` fallback where they're looked up
const ADDON_PRICES = { "Rush delivery": 50, "Platform cut": 30, "Captions": 35, "Censored preview": 45, "Intro/outro bumper": 75, "Extra revision": 30 };

// Add-ons scale with tier (Scene +50%, Feature +150%) and some aren't offered at all on Free —
// a short/simple edit doesn't need captions, a bumper, or an extra revision round baked in.
const FREE_TIER_EXCLUDED_ADDONS = ["Captions", "Intro/outro bumper", "Extra revision"];
const TIER_ADDON_MULTIPLIERS = { Scene: 1.5, Feature: 2.5 }; // Free and Custom default to 1x in addonPriceForTier

const SIGNUP_DISCOUNT_PERCENT = 15;
const SIGNUP_DISCOUNT_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
const SIGNUP_DISCOUNT_CODE = "WELCOME"; // reserved — never matchable as a real, admin-created Coupon code

const MAX_COUPONS_PER_BOOKING = 3;

// "Clip" kept for historical revenue reporting even though it's no longer offered (see PRICING_TIERS usage in revenue-by-tier analytics).
const PRICING_TIERS = ["Clip", "Free", "Scene", "Feature", "Custom"];

const SERVICE_TYPES = ["Video Editing", "Color Grading", "Sound Design", "Motion Graphics"];

module.exports = { TIER_PRICES, ADDON_PRICES, FREE_TIER_EXCLUDED_ADDONS, TIER_ADDON_MULTIPLIERS, SIGNUP_DISCOUNT_PERCENT, SIGNUP_DISCOUNT_WINDOW_MS, SIGNUP_DISCOUNT_CODE, MAX_COUPONS_PER_BOOKING, PRICING_TIERS, SERVICE_TYPES };
