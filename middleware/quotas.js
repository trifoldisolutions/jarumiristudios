const BookingRequest = require("../models/BookingRequest");
const User = require("../models/User");
const Application = require("../models/Application");
const { hasCompletedProjectHistory } = require("../services/bookings");
const { GUEST_SUBMISSION_WINDOW_MS, FREE_TIER_SUBMISSION_WINDOW_MS, APPLICATION_SUBMISSION_WINDOW_MS } = require("../config/limits");

// Guests (no account) get 1 /hire submission per rolling 24h, keyed on the visitor
// cookie (middleware/visitor.js) — runs before preCrCode/multer so an over-quota guest costs nothing
// (no BR code generated, no bytes uploaded, nothing to clean up). A guest recognized
// as a returning client (see hasCompletedProjectHistory) is exempt, same as an account
// holder — they've already proven they won't just dump storage and vanish.
async function enforceGuestSubmissionQuota(req, res, next) {
  if (req.session.userId) return next();
  if (await hasCompletedProjectHistory(null, req.visitorId)) return next();
  const since = new Date(Date.now() - GUEST_SUBMISSION_WINDOW_MS);
  const recent = await BookingRequest.exists({ visitorId: req.visitorId, createdAt: { $gte: since } });
  if (recent) {
    return res.render("public/hire", {
      error: "You've already submitted a request in the last 24 hours. Create a free account for unlimited submissions, or check back later.",
      loggedInUser: null,
      lastBooking: null,
      canUploadNow: false,
    });
  }
  next();
}

// Free tier requires an account (so the weekly cap and testimonial/gallery-rights obligation
// below are tied to a real client record, not a clearable cookie). Runs before preCrCode/multer
// so a blocked submission costs nothing, same rationale as enforceGuestSubmissionQuota above.
async function enforceFreeTierGates(req, res, next) {
  if (req.body.pricingTier !== "Free") return next();
  if (!req.session.userId) {
    return res.render("public/hire", {
      error: "The Clip tier requires a free account — sign up or log in first.",
      needsSignup: true,
      formData: req.body,
      loggedInUser: null,
      lastBooking: null,
      canUploadNow: false,
    });
  }
  const user = await User.findById(req.session.userId);
  if (user?.pendingTestimonialObligation) {
    return res.render("public/hire", {
      error: "Please submit a testimonial or grant gallery rights for your previous Clip project before submitting another.",
      formData: req.body,
      loggedInUser: { email: user.email },
      lastBooking: null,
      canUploadNow: false,
    });
  }
  const since = new Date(Date.now() - FREE_TIER_SUBMISSION_WINDOW_MS);
  const recent = await BookingRequest.exists({ clientId: req.session.userId, pricingTier: "Free", createdAt: { $gte: since } });
  if (recent) {
    return res.render("public/hire", {
      error: "You can submit one Clip project per week. Please try again later.",
      formData: req.body,
      loggedInUser: user ? { email: user.email } : null,
      lastBooking: null,
      canUploadNow: false,
    });
  }
  next();
}

// One application per rolling 24h per visitor cookie — applicants have no account concept
// here, so unlike enforceGuestSubmissionQuota this applies regardless of session.userId.
async function enforceApplicationSubmissionQuota(req, res, next) {
  const since = new Date(Date.now() - APPLICATION_SUBMISSION_WINDOW_MS);
  const recent = await Application.exists({ visitorId: req.visitorId, createdAt: { $gte: since } });
  if (recent) {
    return res.status(429).json({ ok: false, error: "You've already submitted an application in the last 24 hours. Please check back later." });
  }
  next();
}

module.exports = { enforceGuestSubmissionQuota, enforceFreeTierGates, enforceApplicationSubmissionQuota };
