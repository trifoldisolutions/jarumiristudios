const fs = require("fs");
const path = require("path");
const BookingRequest = require("../models/BookingRequest");
const User = require("../models/User");
const AdminNotification = require("../models/AdminNotification");
const { fileTypeFromMime } = require("./uploadUtils");
const { isAddonAllowedForTier, addonPriceForTier, addonTotalForTier, calcPercentDiscount } = require("./pricing");
const { TIER_PRICES, SIGNUP_DISCOUNT_PERCENT } = require("../config/pricing");

// Raw-file uploads at initial submission are reserved for clients with a proven track
// record — at least one past booking that actually reached "completed" (a paid deposit
// isn't enough on its own; a paid-but-abandoned project still sat on storage). Checked
// two ways — by account id and by the long-lived visitor cookie — so an anonymous repeat
// client earns the same trust as an account holder without ever signing up. Everyone else
// submits brief + links only and gets file access once a human has reviewed the request
// (see FILE_ADD_ALLOWED_STATUSES).
async function hasCompletedProjectHistory(userId, visitorId) {
  const clauses = [];
  if (userId) clauses.push({ clientId: userId });
  if (visitorId) clauses.push({ visitorId });
  if (!clauses.length) return false;
  return BookingRequest.exists({ $or: clauses, status: "completed" });
}

// Pulls every still-anonymous booking under this account's email into the account —
// not just whichever one prompted the login/signup — so a client who submitted several
// guest requests before ever authenticating gets them all regrouped in one shot. Only
// called once the user has proven ownership of the email (successful login or signup),
// never at anonymous submission time, since matching on email alone isn't proof of identity.
async function linkOrphanedBookings(user) {
  const orphaned = await BookingRequest.find({ clientId: null, email: user.email }).select("_id");
  if (!orphaned.length) return;
  const orphanedIds = orphaned.map((b) => b._id);
  await BookingRequest.updateMany({ _id: { $in: orphanedIds } }, { clientId: user._id });
  const existingIds = new Set(user.bookings.map((id) => id.toString()));
  const newIds = orphanedIds.filter((id) => !existingIds.has(id.toString()));
  if (newIds.length) {
    user.bookings.push(...newIds);
    await user.save();
  }
}

function writeBookingTxt(booking) {
  const date = booking.createdAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const lines = [
    "JARUMIRI STUDIOS — PROJECT BRIEF",
    "=".repeat(40),
    `CR Code:   ${booking.crCode}`,
    `Submitted: ${date}`,
    "",
    "CLIENT",
    `  Name:     ${booking.name}`,
    `  Email:    ${booking.email}`,
    `  Location: ${booking.location}`,
    `  Type:     ${booking.clientType}`,
  ];
  lines.push(
    "",
    "PROJECT",
    `  Services: ${booking.serviceType.join(", ")}`,
    `  Package:  ${booking.pricingTier}`,
  );
  if (booking.pricingTier === "Custom" && booking.budget) lines.push(`  Budget:   ${booking.budget}`);
  if (booking.addOns && booking.addOns.length > 0) lines.push(`  Add-ons:  ${booking.addOns.join(", ")}`);
  lines.push("", "BRIEF", booking.projectBrief);

  if (booking.mediaLinks && booking.mediaLinks.length > 0) {
    lines.push("", "MEDIA LINKS");
    booking.mediaLinks.forEach(l => lines.push(`  - ${l}`));
  }

  if (booking.platforms && booking.platforms.length > 0) {
    lines.push("", "EXTERNAL LINKS");
    booking.platforms.forEach(p => lines.push(`  - ${p.platform}: ${p.handle}`));
  }

  if (booking.uploadedFiles && booking.uploadedFiles.length > 0) {
    lines.push("", `UPLOADED FILES (${booking.uploadedFiles.length})`);
    booking.uploadedFiles.forEach(f => {
      const sizeLabel = f.size < 1024 * 1024
        ? (f.size / 1024).toFixed(1) + " KB"
        : (f.size / 1024 / 1024).toFixed(1) + " MB";
      lines.push(`  - ${f.originalName} (${fileTypeFromMime(f.mimetype)}, ${sizeLabel})`);
    });
  }

  if (booking.pricingTier !== "Custom") {
    const basePrice = TIER_PRICES[booking.pricingTier] || 0;
    const addonTotal = addonTotalForTier(booking.pricingTier, booking.addOns);
    const subtotal = basePrice + addonTotal;
    lines.push("", "PRICING", `  ${booking.pricingTier} package: $${basePrice}`);
    (booking.addOns || []).forEach(a => {
      if (!isAddonAllowedForTier(booking.pricingTier, a)) return;
      const price = addonPriceForTier(booking.pricingTier, a);
      if (price) lines.push(`  ${a}: +$${price}`);
    });
    lines.push(`  Subtotal: $${subtotal}`);
    if (booking.couponCodes && booking.couponCodes.length > 0) {
      booking.couponCodes.forEach((c) => lines.push(`  Coupon ${c.code}: -$${c.amount.toFixed(2)}`));
      lines.push(`  Total: $${(subtotal - booking.discountAmount).toFixed(2)}`);
    }
  }

  const dir = path.join(__dirname, "..", "uploads", booking.crCode);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "booking.txt"), lines.join("\n"), "utf8");
}

// AdminNotification.message is rendered as raw HTML in the admin UI (for the bold/colored
// cost label below), so any user-controlled text folded into it must be escaped here first.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function notifyAdminNewBooking(booking) {
  const basePrice = TIER_PRICES[booking.pricingTier] || 0;
  const costLabel = booking.pricingTier !== "Custom"
    ? `${booking.pricingTier} package, $${(basePrice + addonTotalForTier(booking.pricingTier, booking.addOns) - (booking.discountAmount || 0)).toFixed(2)}`
    : `Custom${booking.budget ? ` (budget: ${booking.budget})` : ""}`;

  AdminNotification.create({
    bookingId: booking._id,
    crCode: booking.crCode,
    type: "new_booking",
    message: `New booking request from "${escapeHtml(booking.name)}" (${booking.crCode}) — <strong class="font-bold text-amber-400">${escapeHtml(costLabel)}</strong>.`,
  }).catch((err) => console.error("Error creating admin new-booking notification:", err.message));
}

// Anonymous clients have no dashboard to remind them a project moved forward — /track is the
// only place they'll ever look it up again, so it's also the only place we can nudge them
// toward an account (durable identity) instead of relying solely on the visitor cookie, which
// a cleared cache or new device would silently reset (see hasCompletedProjectHistory).
async function trackAccountNudge(booking) {
  if (!booking || booking.clientId) return {};
  const hasAccount = await User.exists({ email: booking.email });

  // Same eligibility/amount logic as GET /hire/success and POST /signup, so the offer shown
  // here matches what signing up would actually apply to this booking.
  let signupDiscountPreview = { eligible: false, amount: 0 };
  if (!hasAccount) {
    const returningEmail = await BookingRequest.exists({ email: booking.email, _id: { $ne: booking._id } });
    const retroactiveEligible = !returningEmail && !booking.agreedPrice && !["declined", "completed"].includes(booking.status);
    if (retroactiveEligible) {
      const subtotal = (TIER_PRICES[booking.pricingTier] || 0) + addonTotalForTier(booking.pricingTier, booking.addOns);
      const running = subtotal - (booking.discountAmount || 0);
      const amount = calcPercentDiscount(running, SIGNUP_DISCOUNT_PERCENT);
      if (amount > 0) signupDiscountPreview = { eligible: true, amount };
    }
  }

  return { hasAccount, signupDiscountPreview };
}

// The signup form is embedded on both /hire/success (right after submission) and /track
// (looking up an existing anonymous booking) — on failure we redirect back to wherever the
// form was actually submitted from rather than always assuming /hire/success. Whitelisted to
// those two known callers (rather than trusting the raw path) since returnTo is client-supplied.
function safeSignupReturnTo(returnTo, crCode) {
  if (returnTo === "track" && crCode) return `/track?code=${encodeURIComponent(crCode)}`;
  return `/hire/success?cr=${crCode}`;
}

module.exports = { hasCompletedProjectHistory, linkOrphanedBookings, writeBookingTxt, escapeHtml, notifyAdminNewBooking, trackAccountNudge, safeSignupReturnTo };
