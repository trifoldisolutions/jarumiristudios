const LoginAttempt = require("../models/LoginAttempt");

// Rolling-window rate limiter, same DB-backed pattern as enforceGuestSubmissionQuota
// and the nudge limiter in routes/app.js. /login keys on the attempted email; /admin/login has
// no email to key on, so it uses the visitor cookie instead (see assignVisitorId).
// /forgot-password keys on the submitted email too, capping inbox spam.
async function isRateLimited(key, max, windowMs) {
  const since = new Date(Date.now() - windowMs);
  const count = await LoginAttempt.countDocuments({ key, createdAt: { $gte: since } });
  return count >= max;
}

// Oldest attempt still inside the window is the one whose expiry frees up a slot.
async function getRateLimitRetryAt(key, windowMs) {
  const since = new Date(Date.now() - windowMs);
  const oldest = await LoginAttempt.findOne({ key, createdAt: { $gte: since } }).sort({ createdAt: 1 });
  return oldest ? new Date(oldest.createdAt.getTime() + windowMs) : null;
}

module.exports = { isRateLimited, getRateLimitRetryAt };
