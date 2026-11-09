const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const BookingRequest = require("../models/BookingRequest");

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "jarumiri-dev-secret",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
});

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect("/admin/login");
};

const requireClient = (req, res, next) => {
  if (req.session.userId) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
};

const requireAssociate = (req, res, next) => {
  if (req.session.associateId) return next();
  res.redirect("/associate/login");
};

// Ownership guard for /associate/booking/:id/* routes — an editor may only act on a project
// currently assigned to them, regardless of whether they claimed it or the superadmin assigned it.
async function requireAssignedBooking(req, res, next) {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.archived || booking.assignedTo?.toString() !== req.session.associateId) {
    return res.redirect("/associate");
  }
  req.booking = booking;
  req.crCode = booking.crCode;
  next();
}

module.exports = { sessionMiddleware, requireAdmin, requireClient, requireAssociate, requireAssignedBooking };
