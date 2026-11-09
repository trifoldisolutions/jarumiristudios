const crypto = require("crypto");

const VISITOR_ID_COOKIE = "jrmr_vid";
const VISITOR_ID_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // ~1 year

// Long-lived anonymous visitor id, set for every visitor (not just guests) so it's
// already present by the time someone reaches /hire, and stored on every booking
// regardless of tier — reusable if a "returning client" tier gets added later.
function assignVisitorId(req, res, next) {
  let vid = req.cookies?.[VISITOR_ID_COOKIE];
  if (!vid) {
    vid = crypto.randomUUID();
    res.cookie(VISITOR_ID_COOKIE, vid, {
      maxAge: VISITOR_ID_MAX_AGE,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  req.visitorId = vid;
  next();
}

module.exports = { assignVisitorId };
