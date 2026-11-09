const express = require("express");
const path = require("path");
const crypto = require("crypto");
const BookingRequest = require("../models/BookingRequest");
const User = require("../models/User");
const Notification = require("../models/Notification");
const AdminNotification = require("../models/AdminNotification");
const AssociateNotification = require("../models/AssociateNotification");
const Message = require("../models/Message");
const LoginAttempt = require("../models/LoginAttempt");
const PasswordResetToken = require("../models/PasswordResetToken");
const { MEMBER_MAX_FILES, MAX_PLATFORM_LINKS, CHAT_MAX_ATTACHMENTS, LOGIN_MAX_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS, RESET_MAX_ATTEMPTS, RESET_ATTEMPT_WINDOW_MS } = require("../config/limits");
const { TIER_PRICES, ADDON_PRICES, SIGNUP_DISCOUNT_PERCENT, SIGNUP_DISCOUNT_WINDOW_MS, SIGNUP_DISCOUNT_CODE } = require("../config/pricing");
const { requireClient } = require("../middleware/auth");
const { upload, chatUpload, attachCrCodeForClient } = require("../middleware/upload");
const { sendAdminPauseAlert, sendPasswordResetEmail } = require("../services/mailer");
const { fileTypeFromMime } = require("../services/uploadUtils");
const { io, chatRoom } = require("../services/chatSocket");
const { addonTotalForTier, welcomeDiscountEligible, calcPercentDiscount } = require("../services/pricing");
const { deliverableDiskFolder, chatDiskFolder, diskFolderFor, redirectToStoredFile, moveStoredFile, archiveAndWipeBookingFiles, generateBlurDataUrl } = require("../services/storage");
const { hasCompletedProjectHistory, linkOrphanedBookings, safeSignupReturnTo } = require("../services/bookings");
const { messageAttachments, softDeleteMessage, buildReplySnapshot, resolveTaggedAttachments, clientMessageThreads } = require("../services/messages");
const { isRateLimited, getRateLimitRetryAt } = require("../services/rateLimit");

const router = express.Router();

// ── Client auth routes ──
router.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("app/auth/login", { next: req.query.next || "/dashboard", cr: req.query.cr || "", reset: req.query.reset === "1" });
});

router.post("/login", async (req, res) => {
  const { email, password, next, cr } = req.body;
  const attemptKey = `login:${email?.trim().toLowerCase() || ""}`;

  if (await isRateLimited(attemptKey, LOGIN_MAX_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS)) {
    return res.render("app/auth/login", { error: "Too many failed attempts. Please try again in a few minutes.", next: next || "/dashboard", cr });
  }

  const user = await User.findOne({ email: email?.trim().toLowerCase() });
  if (!user || !(await user.verifyPassword(password))) {
    await LoginAttempt.create({ key: attemptKey });
    return res.render("app/auth/login", { error: "Invalid email or password.", next: next || "/dashboard", cr });
  }
  await LoginAttempt.deleteMany({ key: attemptKey });
  req.session.userId = user._id.toString();

  await linkOrphanedBookings(user);

  res.redirect(next && next.startsWith("/") ? next : "/dashboard");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

router.get("/signup", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("app/auth/signup", { next: req.query.next || "/dashboard", error: null });
});

router.post("/signup", async (req, res) => {
  const { email, password, crCode, returnTo, next } = req.body;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // The standalone /signup page (no crCode) is for a genuinely brand-new client with no booking
  // to attach yet — it renders its own inline error instead of bouncing through the
  // multi-purpose hire/track redirect dance below, which exists only to return embedded-form
  // submitters to whichever page they submitted from.
  const standalone = !crCode;
  const backTo = (error) => standalone
    ? res.render("app/auth/signup", { next: next && next.startsWith("/") ? next : "/dashboard", error })
    : res.redirect(safeSignupReturnTo(returnTo, crCode));

  if (!email || !emailRe.test(email) || !password || password.length < 8) {
    return backTo("Please enter a valid email and a password of at least 8 characters.");
  }

  let booking = null;
  if (!standalone) {
    booking = await BookingRequest.findOne({ crCode: crCode.toUpperCase().trim() });
    if (!booking) return res.redirect("/hire");

    // A booking already linked to an account can't be re-signed-up-for — without this, POSTing
    // here repeatedly with fresh, never-before-seen emails would hijack the booking (clientId just
    // gets overwritten) and stack a fresh 15% coupon onto it every time, since retroactiveEligible
    // only checks the new email's own history, not whether this booking already has an owner.
    // The real next step for an already-linked booking is logging into the account that owns it.
    if (booking.clientId) {
      return res.redirect(`/login?next=/dashboard&cr=${encodeURIComponent(crCode)}`);
    }
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();

    // The welcome discount is for genuinely brand-new clients only: anyone who has submitted a
    // project before — signed up or not, paid or not — is a returning email and doesn't get it
    // again. This also naturally covers the delete-account-and-resignup loophole (POST
    // /dashboard/account/delete hard-deletes the User but leaves past bookings in place) and
    // guests who already paid and completed a project without ever creating an account.
    const returningEmail = await BookingRequest.exists({
      email: normalizedEmail,
      ...(booking ? { _id: { $ne: booking._id } } : {}),
    });

    // If the triggering booking hasn't been priced yet, apply the discount to it directly instead
    // of leaving it for a future booking — this is what actually makes it an acquisition incentive
    // ("sign up now and get 15% off this project") rather than a reward discovered later. Once a
    // booking has an agreedPrice, editing couponCodes/discountAmount has zero real billing effect
    // (Stripe invoices are keyed off agreedPrice alone — see createDepositInvoice), so that's the
    // natural, abuse-proof cutoff: nobody can sign up right before paying to shave off 15%.
    // Standalone signups have no booking yet, so there's nothing to apply this to — they still
    // get the discountPercent/discountExpiresAt window below to claim on their first booking.
    let discountAppliedRetroactively = false;
    if (booking) {
      const retroactiveEligible = !returningEmail && !booking.agreedPrice && !["declined", "completed"].includes(booking.status);
      if (retroactiveEligible) {
        const subtotal = (TIER_PRICES[booking.pricingTier] || 0) + addonTotalForTier(booking.pricingTier, booking.addOns);
        const running = subtotal - (booking.discountAmount || 0);
        const amount = calcPercentDiscount(running, SIGNUP_DISCOUNT_PERCENT);
        if (amount > 0) {
          booking.couponCodes.push({ code: SIGNUP_DISCOUNT_CODE, discountType: "percent", discountValue: SIGNUP_DISCOUNT_PERCENT, amount });
          booking.discountAmount = (booking.discountAmount || 0) + amount;
          discountAppliedRetroactively = true;
        }
      }
    }

    const user = new User({
      email: normalizedEmail,
      password,
      name: booking?.name || "",
      location: booking?.location || "",
      bookings: booking ? [booking._id] : [],
      notificationPreferences: { emailUpdates: booking ? booking.emailConsent : true },
      ...(returningEmail ? {} : {
        discountPercent: SIGNUP_DISCOUNT_PERCENT,
        discountExpiresAt: new Date(Date.now() + SIGNUP_DISCOUNT_WINDOW_MS),
        discountUsed: discountAppliedRetroactively,
      }),
    });
    await user.save();
    if (booking) {
      booking.clientId = user._id;
      await booking.save();
    }
    await linkOrphanedBookings(user);
    req.session.userId = user._id.toString();
    res.redirect(standalone && next && next.startsWith("/") ? next : "/dashboard");
  } catch (err) {
    if (err.code === 11000) {
      // Email already taken — send back to the originating page with an error hint
      return backTo(standalone ? "That email is already registered." : undefined);
    }
    console.error("Signup error:", err);
    return backTo(standalone ? "Something went wrong. Please try again." : undefined);
  }
});

router.get("/forgot-password", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("app/auth/forgot-password", { submitted: false, rateLimited: false, retryAt: null });
});

router.post("/forgot-password", async (req, res) => {
  const email = req.body.email?.trim().toLowerCase() || "";
  const attemptKey = `reset:${email}`;

  // Rate-limit status is safe to surface directly: it's checked before the user
  // lookup below, so it behaves identically whether or not the email is on file —
  // it can't be used to enumerate accounts.
  if (email && (await isRateLimited(attemptKey, RESET_MAX_ATTEMPTS, RESET_ATTEMPT_WINDOW_MS))) {
    const retryAt = await getRateLimitRetryAt(attemptKey, RESET_ATTEMPT_WINDOW_MS);
    return res.render("app/auth/forgot-password", { submitted: false, rateLimited: true, retryAt });
  }

  // Always render the same neutral confirmation, whether or not the email is
  // on file — avoids leaking account existence.
  if (email) {
    await LoginAttempt.create({ key: attemptKey });
    const user = await User.findOne({ email });
    if (user) {
      await PasswordResetToken.deleteMany({ userId: user._id });
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      await PasswordResetToken.create({ userId: user._id, tokenHash });
      sendPasswordResetEmail(user, rawToken);
    }
  }

  res.render("app/auth/forgot-password", { submitted: true, rateLimited: false, retryAt: null });
});

router.get("/reset-password/:token", async (req, res) => {
  const tokenHash = crypto.createHash("sha256").update(req.params.token).digest("hex");
  const tokenDoc = await PasswordResetToken.findOne({ tokenHash });
  const valid = !!tokenDoc && Date.now() - tokenDoc.createdAt.getTime() < 60 * 60 * 1000;
  res.render("app/auth/reset-password", { valid, token: req.params.token, error: null });
});

router.post("/reset-password/:token", async (req, res) => {
  const { newPassword, confirmPassword } = req.body;
  const tokenHash = crypto.createHash("sha256").update(req.params.token).digest("hex");
  const tokenDoc = await PasswordResetToken.findOne({ tokenHash });
  const valid = !!tokenDoc && Date.now() - tokenDoc.createdAt.getTime() < 60 * 60 * 1000;

  if (!valid) {
    return res.render("app/auth/reset-password", { valid: false, token: req.params.token, error: null });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.render("app/auth/reset-password", { valid: true, token: req.params.token, error: "New password must be at least 8 characters." });
  }
  if (newPassword !== confirmPassword) {
    return res.render("app/auth/reset-password", { valid: true, token: req.params.token, error: "Passwords don't match." });
  }

  const user = await User.findById(tokenDoc.userId);
  if (!user) {
    return res.render("app/auth/reset-password", { valid: false, token: req.params.token, error: null });
  }
  user.password = newPassword;
  await user.save();
  await PasswordResetToken.deleteMany({ userId: user._id });

  res.redirect("/login?reset=1");
});

// Inject unread notification count into all /dashboard views
router.use("/dashboard", async (req, res, next) => {
  res.locals.unreadCount = 0;
  res.locals.unreadMessageCount = 0;
  if (req.session.userId) {
    try {
      res.locals.unreadCount = await Notification.countDocuments({ userId: req.session.userId, read: false });
      res.locals.unreadMessageCount = await Message.countDocuments({ clientId: req.session.userId, senderRole: "admin", read: false });
    } catch {}
  }
  next();
});

router.get("/dashboard", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId).populate({
    path: "bookings",
    match: { filesDeleted: { $ne: true } },
    select: "crCode serviceType pricingTier addOns discountAmount status createdAt revisions uploadedFiles deliverableFiles agreedPrice depositStatus depositInvoiceUrl finalPaymentStatus finalInvoiceUrl projectBrief archived testimonial galleryRightsGranted",
    options: { sort: { createdAt: -1 } },
  });
  if (!user) {
    req.session.destroy(() => res.redirect("/login"));
    return;
  }
  res.render("app/dashboard", {
    user,
    submitted: req.query.submitted || null,
    testimonialSubmitted: req.query.testimonialSubmitted || null,
    testimonialError: req.query.testimonialError || null,
    TIER_PRICES,
    ADDON_PRICES,
  });
});

router.get("/dashboard/account", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
  res.render("app/account", { user, success: req.query.success || null, error: null });
});

router.post("/dashboard/account/profile", requireClient, async (req, res) => {
  const { name, location, clientType } = req.body;
  if (!name?.trim() || !location?.trim()) {
    const user = await User.findById(req.session.userId);
    return res.render("app/account", { user, error: "Name and location are required.", success: null });
  }

  const platformNames   = [].concat(req.body.platformNames   || []);
  const platformHandles = [].concat(req.body.platformHandles || []);
  const update = {
    name: name.trim(),
    location: location.trim(),
    clientType: (clientType || "").trim(),
    platforms: platformNames
      .map((platform, i) => ({ platform, handle: (platformHandles[i] || "").trim() }))
      .filter((p) => p.platform && p.handle)
      .slice(0, MAX_PLATFORM_LINKS),
  };

  await User.findByIdAndUpdate(req.session.userId, update);
  const redirectTo = req.query.next || "/dashboard/account";
  res.redirect(redirectTo.startsWith("/") ? redirectTo : "/dashboard/account");
});

router.post("/dashboard/account/notifications", requireClient, async (req, res) => {
  await User.findByIdAndUpdate(req.session.userId, { "notificationPreferences.emailUpdates": req.body.emailUpdates === "on" });
  res.redirect("/dashboard/account?success=1");
});

router.post("/dashboard/account/password", requireClient, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }

  if (!await user.verifyPassword(currentPassword)) {
    return res.render("app/account", { user, error: "Current password is incorrect.", success: null });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.render("app/account", { user, error: "New password must be at least 8 characters.", success: null });
  }
  if (newPassword !== confirmPassword) {
    return res.render("app/account", { user, error: "Passwords don't match.", success: null });
  }

  user.password = newPassword;
  await user.save();
  res.redirect("/dashboard/account?success=1");
});

router.post("/dashboard/account/delete", requireClient, async (req, res) => {
  const { confirmEmail } = req.body;
  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
  if (!confirmEmail || confirmEmail.trim().toLowerCase() !== user.email) {
    return res.render("app/account", { user, success: null, error: "Email confirmation didn't match. Account not deleted." });
  }

  // Deleting the account cascades exactly like deleting each project individually — same
  // irreversible wipe of raw footage and chat attachments — since an orphaned clientId would
  // otherwise leave them stranded on disk with no owner able to reach or clean them up.
  // Delivered final files are kept on record (see archiveAndWipeBookingFiles).
  const bookings = await BookingRequest.find({ clientId: user._id, filesDeleted: { $ne: true } }).select("crCode deliverableFiles");
  await BookingRequest.updateMany(
    { clientId: user._id },
    { filesDeleted: true, uploadedFiles: [], archived: true }
  );
  bookings.forEach((b) => archiveAndWipeBookingFiles(b.crCode, (b.deliverableFiles || []).map((f) => f.storageKey)));

  await User.findByIdAndDelete(user._id);
  req.session.destroy(() => res.redirect("/"));
});

router.get("/dashboard/invoices", requireClient, async (req, res) => {
  const bookings = await BookingRequest.find({ clientId: req.session.userId, filesDeleted: { $ne: true } })
    .select("crCode agreedPrice depositStatus depositInvoiceUrl depositDueDate finalPaymentStatus finalInvoiceUrl finalDueDate revisionInvoices createdAt")
    .sort({ createdAt: -1 });

  const invoices = [];
  bookings.forEach((booking) => {
    if (booking.depositStatus && booking.depositStatus !== "none") {
      invoices.push({
        bookingId: booking._id,
        crCode: booking.crCode,
        label: "Deposit (30%)",
        amount: booking.agreedPrice ? booking.agreedPrice * 0.30 : null,
        status: booking.depositStatus,
        dueDate: booking.depositDueDate,
        invoiceUrl: booking.depositInvoiceUrl,
        sortDate: booking.depositDueDate || booking.createdAt,
      });
    }
    if (booking.finalPaymentStatus && booking.finalPaymentStatus !== "none") {
      invoices.push({
        bookingId: booking._id,
        crCode: booking.crCode,
        label: "Final payment (70%)",
        amount: booking.agreedPrice ? booking.agreedPrice * 0.70 : null,
        status: booking.finalPaymentStatus,
        dueDate: booking.finalDueDate,
        invoiceUrl: booking.finalInvoiceUrl,
        sortDate: booking.finalDueDate || booking.createdAt,
      });
    }
    (booking.revisionInvoices || []).forEach((ri) => {
      invoices.push({
        bookingId: booking._id,
        crCode: booking.crCode,
        label: "Revision",
        amount: ri.amount,
        status: ri.status,
        dueDate: ri.dueDate,
        invoiceUrl: ri.invoiceUrl,
        sortDate: ri.createdAt,
      });
    });
  });
  invoices.sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate));

  res.render("app/invoices", { invoices });
});

router.get("/dashboard/new", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    req.session.destroy(() => res.redirect("/login"));
    return;
  }
  const profileComplete = !!(user.name?.trim() && user.location?.trim() && user.platforms?.length && user.clientType?.trim());
  const [canUploadNow, lastBooking] = await Promise.all([
    hasCompletedProjectHistory(req.session.userId, req.visitorId),
    user.bookings?.length
      ? BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("clientType platforms")
      : null,
  ]);
  const welcomeDiscount = welcomeDiscountEligible(user) ? { percent: user.discountPercent } : null;
  res.render("app/new", { user, profileComplete, canUploadNow, lastBooking, welcomeDiscount });
});

router.get("/dashboard/booking/:id", requireClient, async (req, res) => {
  const [booking, user] = await Promise.all([
    BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId, filesDeleted: { $ne: true } }),
    User.findById(req.session.userId).select("email"),
  ]);
  if (!booking) return res.redirect("/dashboard");
  const bookingUnreadMessageCount = await Message.countDocuments({ bookingId: booking._id, senderRole: "admin", read: false });
  res.render("app/booking", { booking, user, bookingUnreadMessageCount });
});

router.post("/dashboard/booking/:id/delete", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, clientId: req.session.userId },
    { filesDeleted: true, uploadedFiles: [], archived: true }
  );
  archiveAndWipeBookingFiles(booking?.crCode, (booking?.deliverableFiles || []).map((f) => f.storageKey));
  res.redirect("/dashboard");
});

router.post("/dashboard/booking/:id/pause", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    {
      _id: req.params.id,
      clientId: req.session.userId,
      archived: { $ne: true },
      status: { $nin: ["declined", "completed", "paused"] },
    },
    { status: "paused" },
    { new: true }
  );
  if (!booking) return res.sendStatus(404);
  sendAdminPauseAlert(booking);
  res.sendStatus(200);
});

router.post("/dashboard/booking/:id/nudge", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({
    _id: req.params.id,
    clientId: req.session.userId,
    archived: { $ne: true },
    status: { $nin: ["declined", "completed"] },
  });
  if (!booking) return res.sendStatus(404);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentNudges = await AdminNotification.countDocuments({
    bookingId: booking._id,
    type: "nudge",
    createdAt: { $gte: oneHourAgo },
  });
  if (recentNudges >= 3) {
    return res.status(429).json({ error: "You can only nudge up to 3 times per hour." });
  }

  await AdminNotification.create({
    bookingId: booking._id,
    crCode: booking.crCode,
    type: "nudge",
    message: `${booking.name} nudged you about project ${booking.crCode}.`,
  });
  res.sendStatus(200);
});

router.post("/dashboard/booking/:id/revision", requireClient, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.redirect(`/dashboard/booking/${req.params.id}`);
  await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, clientId: req.session.userId },
    { $push: { revisions: { message: message.trim() } } }
  );
  res.redirect(`/dashboard/booking/${req.params.id}`);
});

// Clears the Free-tier obligation set in notifyStatusChange when the booking completed —
// either a written testimonial or granting gallery/distribution rights satisfies it.
router.post("/dashboard/booking/:id/testimonial", requireClient, async (req, res) => {
  const testimonialText = (req.body.testimonialText || "").trim();
  const grantGalleryRights = req.body.grantGalleryRights === "on";
  if (!testimonialText && !grantGalleryRights) {
    return res.redirect(`/dashboard?testimonialError=${encodeURIComponent("Please write a testimonial or grant gallery rights.")}`);
  }

  const user = await User.findById(req.session.userId).select("pendingTestimonialObligation pendingTestimonialBookingId");
  if (!user?.pendingTestimonialObligation || String(user.pendingTestimonialBookingId) !== req.params.id) {
    return res.redirect("/dashboard");
  }

  const update = {};
  if (testimonialText) update.testimonial = { text: testimonialText, submittedAt: new Date() };
  if (grantGalleryRights) {
    update.galleryRightsGranted = true;
    update.galleryRightsGrantedAt = new Date();
  }
  await BookingRequest.updateOne({ _id: req.params.id, clientId: req.session.userId }, update);
  await User.updateOne({ _id: req.session.userId }, { pendingTestimonialObligation: false, pendingTestimonialBookingId: null });

  res.redirect("/dashboard?testimonialSubmitted=1");
});

// Once a booking has actually been looked at (past pending) the client is trusted to add raw
// files — mirrors the trust gate on /hire but keyed on this project's own status instead of
// the client's history, since even a first-time client earns that trust once reviewed.
const FILE_ADD_ALLOWED_STATUSES = ["in-review", "accepted", "in-progress", "paused"];

router.post("/dashboard/booking/:id/upload-files", requireClient, async (req, res, next) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId })
    .select("crCode archived status name uploadedFiles assignedTo");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  if (booking.archived || !FILE_ADD_ALLOWED_STATUSES.includes(booking.status)) {
    return res.status(403).json({ error: "Files can only be added once your project has moved past the initial review stage." });
  }
  req.crCode = booking.crCode;
  req.booking = booking;
  upload.array("files", MEMBER_MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE" ? "You can upload up to 20 files at a time."
      : err.message || "Upload failed.";
    return res.status(400).json({ error: message });
  });
}, async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files received." });
  const newFiles = await Promise.all(req.files.map(async (f) => ({
    originalName: f.originalname,
    storedName: f.filename,
    size: f.size,
    mimetype: f.mimetype,
    folder: "raws",
    storageKey: f.storageKey,
    backend: f.backend,
    blurDataUrl: await generateBlurDataUrl(f.buffer, f.mimetype),
  })));

  const booking = req.booking;
  booking.uploadedFiles.push(...newFiles);
  await booking.save();

  AdminNotification.create({
    bookingId: booking._id,
    crCode: booking.crCode,
    type: "files_added",
    message: `${booking.name} added ${newFiles.length} file${newFiles.length > 1 ? "s" : ""} to project ${booking.crCode}.`,
  }).catch((err) => console.error("Error creating admin files-added notification:", err.message));

  if (booking.assignedTo) {
    AssociateNotification.create({
      associateId: booking.assignedTo,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "files_added",
      message: `${booking.name} added ${newFiles.length} file${newFiles.length > 1 ? "s" : ""} to project ${booking.crCode}.`,
    }).catch((err) => console.error("Error creating associate files-added notification:", err.message));
  }

  res.json({ ok: true, count: newFiles.length });
});

router.get("/dashboard/notifications", requireClient, async (req, res) => {
  const notifications = await Notification.find({ userId: req.session.userId }).sort({ createdAt: -1 });
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.locals.unreadCount = 0;
  res.render("app/notifications", { notifications });
});

router.post("/dashboard/notifications/mark-all-read", requireClient, async (req, res) => {
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.redirect("/dashboard/notifications");
});

// ── Client project chat ──

router.get("/dashboard/messages", requireClient, async (req, res) => {
  const threads = await clientMessageThreads(req.session.userId);
  if (threads === null) { req.session.destroy(() => res.redirect("/login")); return; }
  res.render("app/messages", { threads });
});

router.get("/dashboard/messages/:id", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId });
  if (!booking) return res.redirect("/dashboard/messages");
  const messages = await Message.find({ bookingId: booking._id }).sort({ createdAt: 1 });
  await Message.updateMany({ bookingId: booking._id, senderRole: "admin", read: false }, { read: true });

  if (req.xhr) {
    return res.render("app/partials/message-thread-panel", {
      booking, messages, myRole: "client",
      attachmentBasePath: "/dashboard/messages/attachments",
      postPath: `/dashboard/messages/${booking._id}`,
    });
  }

  const threads = await clientMessageThreads(req.session.userId);
  res.render("app/messages", { threads, booking, messages });
});

router.post("/dashboard/messages/:id", requireClient, attachCrCodeForClient, (req, res, next) => {
  chatUpload.array("attachments", CHAT_MAX_ATTACHMENTS)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const body = (req.body.body || "").trim();

  const attachments = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname, storedName: f.filename, size: f.size, mimetype: f.mimetype, folder: "chat",
    storageKey: f.storageKey, backend: f.backend,
    blurDataUrl: await generateBlurDataUrl(f.buffer, f.mimetype),
  })));
  const tagged = resolveTaggedAttachments(req.booking, req.body.taggedFiles, true);
  if (tagged === null) return res.status(400).json({ error: "One of those files couldn't be found." });
  attachments.push(...tagged);

  if (!body && attachments.length === 0) return res.status(400).json({ error: "Message can't be empty." });

  const replyTo = await buildReplySnapshot(req.params.id, req.body.replyToMessageId);

  const message = await Message.create({
    bookingId: req.params.id,
    crCode: req.booking.crCode,
    clientId: req.booking.clientId,
    senderRole: "client",
    body,
    attachments,
    replyTo,
  });

  const payload = message.toObject();
  payload.chatBlocked = req.booking.chatBlocked;
  io.to(chatRoom(req.params.id)).emit("new-message", payload);
  res.json({ message });
});

router.post("/dashboard/messages/:id/:messageId/delete", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId }).select("_id");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: booking._id, senderRole: "client" });
  if (!message) return res.status(404).json({ error: "Message not found." });
  await softDeleteMessage(message);
  io.to(chatRoom(req.params.id)).emit("message-deleted", { messageId: message._id, bookingId: req.params.id });
  res.json({ ok: true });
});

router.post("/dashboard/messages/:id/:messageId/edit", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId }).select("_id");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  const body = (req.body.body || "").trim();
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: booking._id, senderRole: "client", deleted: false });
  if (!message) return res.status(404).json({ error: "Message not found." });
  if (!body && messageAttachments(message).length === 0) return res.status(400).json({ error: "Message can't be empty." });
  message.body = body;
  message.edited = true;
  await message.save();
  io.to(chatRoom(req.params.id)).emit("message-edited", { messageId: message._id, bookingId: req.params.id, body: message.body });
  res.json({ message });
});

router.get("/dashboard/messages/attachments/:filename", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({
    clientId: req.session.userId,
    $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }],
  });
  if (!message) return res.sendStatus(403);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  const folder = att.folder || "chat";
  if (folder === "deliverables") {
    const booking = await BookingRequest.findById(message.bookingId).select("status");
    if (!booking?.deliverablesUnlocked) return res.sendStatus(403);
  }
  // See the matching comment on the /admin/messages/attachments route in routes/admin.js.
  if (message.senderRole !== "client" && !att.downloaded && req.query.downloaded === "1") {
    att.downloaded = true;
    await message.save();
  }
  if (await redirectToStoredFile(res, message.crCode, diskFolderFor(att, message.senderRole), filename, att)) return;
  res.sendStatus(404);
});

// Client-side equivalent of the admin save-to-project route in routes/admin.js.
router.post("/dashboard/messages/attachments/:filename/save-to-project", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({
    clientId: req.session.userId,
    $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }],
  });
  if (!message) return res.sendStatus(403);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  if (att.folder && att.folder !== "chat") return res.status(400).json({ error: "Already in project files." });

  const booking = await BookingRequest.findById(message.bookingId);
  if (!booking) return res.sendStatus(404);
  if (booking.archived) return res.status(403).json({ error: "This project is archived." });

  const type = "raws";
  if (!(await moveStoredFile(message.crCode, chatDiskFolder(message.senderRole), type, filename, att))) {
    return res.status(404).json({ error: "File not found on disk." });
  }

  booking.uploadedFiles.push({ originalName: att.originalName, storedName: att.storedName, size: att.size, mimetype: att.mimetype, blurDataUrl: att.blurDataUrl, storageKey: att.storageKey, backend: att.backend, folder: type });
  await booking.save();

  att.folder = type;
  await message.save();

  res.json({ ok: true });
});

router.get("/dashboard/gallery", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId).populate({
    path: "bookings",
    select: "crCode serviceType pricingTier status createdAt uploadedFiles",
    options: { sort: { createdAt: -1 } },
  });
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
  const projects = (user.bookings || []).filter(b => b.uploadedFiles && b.uploadedFiles.length > 0);
  res.render("app/gallery", { projects });
});

router.get("/dashboard/uploads/:filename", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    clientId: req.session.userId,
    "uploadedFiles.storedName": filename,
  });
  if (!booking) return res.sendStatus(403);
  const fileInfo = booking.uploadedFiles.find(f => f.storedName === filename);
  const folder = fileInfo.folder || fileTypeFromMime(fileInfo.mimetype);
  if (await redirectToStoredFile(res, booking.crCode, folder, filename, fileInfo)) return;
  res.sendFile(path.join(__dirname, "..", "uploads", filename));
});

router.get("/dashboard/deliverables/:filename", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    clientId: req.session.userId,
    "deliverableFiles.storedName": filename,
  });
  if (!booking || !booking.deliverablesUnlocked) return res.sendStatus(403);
  const fileInfo = booking.deliverableFiles.find(f => f.storedName === filename);
  if (await redirectToStoredFile(res, booking.crCode, deliverableDiskFolder(), filename, fileInfo)) return;
  res.sendStatus(404);
});

router.routes = [
  { method: "GET", path: "/login", label: "Log in" },
  { method: "POST", path: "/login", label: "Log in (form)" },
  { method: "GET", path: "/logout", label: "Log out" },
  { method: "GET", path: "/signup", label: "Sign up" },
  { method: "POST", path: "/signup", label: "Sign up (form)" },
  { method: "GET", path: "/forgot-password", label: "Forgot password" },
  { method: "POST", path: "/forgot-password", label: "Send a reset link" },
  { method: "GET", path: "/reset-password/:token", label: "Choose a new password (link from the email)" },
  { method: "POST", path: "/reset-password/:token", label: "Save the new password" },
  { method: "GET", path: "/dashboard", label: "Client dashboard" },
  { method: "GET", path: "/dashboard/account", label: "Account settings" },
  { method: "POST", path: "/dashboard/account/profile", label: "Save profile" },
  { method: "POST", path: "/dashboard/account/notifications", label: "Save email preferences" },
  { method: "POST", path: "/dashboard/account/password", label: "Change password" },
  { method: "POST", path: "/dashboard/account/delete", label: "Delete account" },
  { method: "GET", path: "/dashboard/invoices", label: "Invoices" },
  { method: "GET", path: "/dashboard/new", label: "New project form" },
  { method: "GET", path: "/dashboard/booking/:id", label: "Project page" },
  { method: "POST", path: "/dashboard/booking/:id/delete", label: "Delete a project" },
  { method: "POST", path: "/dashboard/booking/:id/pause", label: "Pause a project" },
  { method: "POST", path: "/dashboard/booking/:id/nudge", label: "Nudge the studio about a project" },
  { method: "POST", path: "/dashboard/booking/:id/revision", label: "Request a revision" },
  { method: "POST", path: "/dashboard/booking/:id/testimonial", label: "Submit a testimonial or grant gallery rights" },
  { method: "POST", path: "/dashboard/booking/:id/upload-files", label: "Add files to a project" },
  { method: "GET", path: "/dashboard/notifications", label: "Notifications" },
  { method: "POST", path: "/dashboard/notifications/mark-all-read", label: "Mark all notifications read" },
  { method: "GET", path: "/dashboard/messages", label: "Project chat inbox" },
  { method: "GET", path: "/dashboard/messages/:id", label: "Project chat thread" },
  { method: "POST", path: "/dashboard/messages/:id", label: "Send a chat message" },
  { method: "POST", path: "/dashboard/messages/:id/:messageId/delete", label: "Delete a chat message" },
  { method: "POST", path: "/dashboard/messages/:id/:messageId/edit", label: "Edit a chat message" },
  { method: "GET", path: "/dashboard/messages/attachments/:filename", label: "Download a chat attachment" },
  { method: "POST", path: "/dashboard/messages/attachments/:filename/save-to-project", label: "Save a chat attachment to the project" },
  { method: "GET", path: "/dashboard/gallery", label: "File gallery" },
  { method: "GET", path: "/dashboard/uploads/:filename", label: "Download an uploaded file" },
  { method: "GET", path: "/dashboard/deliverables/:filename", label: "Download a final file" },
];

module.exports = router;
