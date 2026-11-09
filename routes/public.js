const express = require("express");
const path = require("path");
const BookingRequest = require("../models/BookingRequest");
const User = require("../models/User");
const Coupon = require("../models/Coupon");
const Role = require("../models/Role");
const Application = require("../models/Application");
const { MEMBER_MAX_FILES, MAX_PLATFORM_LINKS } = require("../config/limits");
const { TIER_PRICES, SIGNUP_DISCOUNT_PERCENT, SIGNUP_DISCOUNT_CODE, MAX_COUPONS_PER_BOOKING } = require("../config/pricing");
const { enforceGuestSubmissionQuota, enforceFreeTierGates, enforceApplicationSubmissionQuota } = require("../middleware/quotas");
const { preCrCode, preAppCode, upload, applicationUpload } = require("../middleware/upload");
const { sendBookingConfirmation, sendAdminNewBookingAlert, sendAdminNewApplicationAlert } = require("../services/mailer");
const { fileTypeFromMime } = require("../services/uploadUtils");
const { addonTotalForTier, isAddonAllowedForTier, welcomeDiscountEligible, calcPercentDiscount } = require("../services/pricing");
const { deliverableDiskFolder, redirectToStoredFile, generateBlurDataUrl } = require("../services/storage");
const { hasCompletedProjectHistory, writeBookingTxt, notifyAdminNewBooking, trackAccountNudge } = require("../services/bookings");

const router = express.Router();

router.get("/", (req, res) => {
  res.render("public/index");
});

router.get("/career", async (req, res) => {
  const roles = await Role.find({ active: true }).sort({ order: 1, createdAt: 1 });
  res.render("public/career", { roles });
});

router.get("/terms", (req, res) => {
  res.render("public/terms");
});

const TRACK_SELECT_FIELDS = "crCode name email clientId serviceType pricingTier addOns budget status archived filesDeleted depositStatus depositDueDate depositInvoiceUrl finalPaymentStatus finalDueDate finalInvoiceUrl deliveryDate deliverableFiles createdAt discountAmount agreedPrice";

router.get("/track", async (req, res) => {
  const { code, name, email } = req.query;

  if (!code && !name && !email) return res.render("public/track");

  if (name || email) {
    const booking = await BookingRequest.findOne({
      name: { $regex: new RegExp(`^${name?.trim()}$`, "i") },
      email: email?.trim().toLowerCase(),
    }).select(TRACK_SELECT_FIELDS);
    const nudge = await trackAccountNudge(booking);
    return res.render("public/track", { searched: true, method: "identity", name: name?.trim(), email: email?.trim(), booking, ...nudge });
  }

  const booking = await BookingRequest.findOne({ crCode: code.toUpperCase().trim() })
    .select(TRACK_SELECT_FIELDS);
  const nudge = await trackAccountNudge(booking);
  res.render("public/track", { searched: true, method: "code", code: code.toUpperCase().trim(), booking, ...nudge });
});

// Smart link used in emails: sends the client to their project page if
// they're logged in and own it, otherwise falls back to the tracking page.
router.get("/go/:crCode", async (req, res) => {
  const crCode = req.params.crCode.toUpperCase().trim();
  if (req.session.userId) {
    const booking = await BookingRequest.findOne({ crCode, clientId: req.session.userId, filesDeleted: { $ne: true } }).select("_id");
    if (booking) return res.redirect(`/dashboard/booking/${booking._id}`);
  }
  res.redirect(`/track?code=${encodeURIComponent(crCode)}`);
});

router.get("/hire", async (req, res) => {
  if (!req.session.userId) {
    const canUploadNow = await hasCompletedProjectHistory(null, req.visitorId);
    return res.render("public/hire", { canUploadNow });
  }
  const user = await User.findById(req.session.userId);
  const [lastBooking, canUploadNow] = await Promise.all([
    user?.bookings?.length
      ? BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("name location clientType platforms")
      : null,
    hasCompletedProjectHistory(req.session.userId, req.visitorId),
  ]);
  const welcomeDiscount = welcomeDiscountEligible(user) ? { percent: user.discountPercent } : null;
  res.render("public/hire", {
    loggedInUser: { email: user.email },
    lastBooking,
    platforms: user.platforms || [],
    clientType: user.clientType || "",
    canUploadNow,
    welcomeDiscount,
  });
});

router.get("/hire/success", async (req, res) => {
  const { cr } = req.query;
  if (!cr) return res.redirect("/hire");
  const booking = await BookingRequest.findOne({ crCode: cr }).select("email clientId pricingTier addOns couponCodes discountAmount status agreedPrice");
  if (!booking) return res.redirect("/hire");
  const alreadyLinked = !!booking.clientId;
  const existingUser = !alreadyLinked && await User.exists({ email: booking.email });

  // Preview of the signup-discount offer for the "create an account" card below — mirrors the
  // same eligibility/amount logic POST /signup actually applies, so the promise made here matches
  // what the client will really get.
  let signupDiscountPreview = { eligible: false, amount: 0 };
  if (!alreadyLinked && !existingUser) {
    const returningEmail = await BookingRequest.exists({ email: booking.email, _id: { $ne: booking._id } });
    const retroactiveEligible = !returningEmail && !booking.agreedPrice && !["declined", "completed"].includes(booking.status);
    if (retroactiveEligible) {
      const subtotal = (TIER_PRICES[booking.pricingTier] || 0) + addonTotalForTier(booking.pricingTier, booking.addOns);
      const running = subtotal - (booking.discountAmount || 0);
      const amount = calcPercentDiscount(running, SIGNUP_DISCOUNT_PERCENT);
      if (amount > 0) signupDiscountPreview = { eligible: true, amount };
    }
  }

  res.render("public/hire", {
    success: true,
    crCode: cr,
    bookingEmail: booking.email,
    alreadyLinked,
    hasAccount: !!existingUser,
    pricingTier: booking.pricingTier,
    addOns: booking.addOns || [],
    couponCodes: booking.couponCodes || [],
    discountAmount: booking.discountAmount || 0,
    signupDiscountPreview,
  });
});

router.post("/hire/coupon/validate", async (req, res) => {
  const code = (req.body.code || "").trim().toUpperCase();
  if (!code) return res.json({ valid: false, message: "Please enter a coupon code." });

  const coupon = await Coupon.findOne({ code, active: true });
  if (!coupon) return res.json({ valid: false, message: "Coupon code not found." });
  if (coupon.expiresAt && new Date() > coupon.expiresAt) return res.json({ valid: false, message: "This coupon has expired." });

  res.json({
    valid: true,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    message: coupon.discountType === "percent"
      ? `${coupon.discountValue}% discount applied`
      : `$${coupon.discountValue} discount applied`,
  });
});

router.post("/hire", enforceGuestSubmissionQuota, enforceFreeTierGates, preCrCode, async (req, res, next) => {
  const canUploadNow = await hasCompletedProjectHistory(req.session.userId, req.visitorId);
  req.canUploadNow = canUploadNow;
  const maxFiles = canUploadNow ? MEMBER_MAX_FILES : 0;
  upload.array("files", maxFiles)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE"
      ? canUploadNow
        ? "You can upload up to 20 files at a time."
        : "Uploads open once you've completed a project with us before, or once this request has been approved."
      : err.message || "Upload failed.";
    return res.render("public/hire", { error: message, formData: req.body, loggedInUser: null, lastBooking: null, canUploadNow });
  });
}, async (req, res) => {
  const { name, email, location, clientType, pricingTier, budget, projectBrief } = req.body;
  const serviceType = [].concat(req.body.serviceType || []).filter(Boolean);
  const mediaLinks  = [].concat(req.body.mediaLinks  || []).filter(Boolean);
  const addOns      = [].concat(req.body.addOns      || []).filter(Boolean);
  const platformNames   = [].concat(req.body.platformNames   || []);
  const platformHandles = [].concat(req.body.platformHandles || []);
  const platforms = platformNames
    .map((platform, i) => ({ platform, handle: (platformHandles[i] || "").trim() }))
    .filter((p) => p.platform && p.handle)
    .slice(0, MAX_PLATFORM_LINKS);
  const canUploadNow = req.canUploadNow;
  const tosAgreed = req.body.tosAgreed === "on";
  const emailConsent = req.body.emailConsent === "on";

  // Server-side validation
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const platformsInvalid = pricingTier === "Free" ? platforms.length !== 3 : !platforms.length;
  if (!name || !email || !emailRe.test(email) || !location || !clientType || !serviceType.length || !pricingTier || !projectBrief || projectBrief.length > 2000 || platformsInvalid || !tosAgreed) {
    let loggedInUser = null;
    let lastBooking = null;
    let platforms = [];
    let accountClientType = "";
    let welcomeDiscount = null;
    if (req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user) {
        loggedInUser = { email: user.email };
        platforms = user.platforms || [];
        accountClientType = user.clientType || "";
        lastBooking = user.bookings?.length
          ? await BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("name location")
          : null;
        welcomeDiscount = welcomeDiscountEligible(user) ? { percent: user.discountPercent } : null;
      }
    }
    return res.render("public/hire", {
      error: "Please fill in all required fields.",
      formData: req.body,
      loggedInUser,
      lastBooking,
      platforms,
      clientType: accountClientType,
      canUploadNow,
      welcomeDiscount,
    });
  }

  let claimedDiscountUserId = null; // rolled back in the catch block if the booking save below fails
  try {
    const uploadedFiles = await Promise.all((req.files || []).map(async (f) => ({
      originalName: f.originalname,
      storedName: f.filename,
      size: f.size,
      mimetype: f.mimetype,
      folder: "raws",
      storageKey: f.storageKey,
      backend: f.backend,
      blurDataUrl: await generateBlurDataUrl(f.buffer, f.mimetype),
    })));

    // Drop any add-on not offered on this tier (e.g. Captions/bumper/extra-revision on Free)
    // before it's priced or persisted — client-side already hides these, this is the real gate.
    const allowedAddOns = addOns.filter((a) => isAddonAllowedForTier(pricingTier, a));

    // Validate coupon server-side
    const basePrice  = TIER_PRICES[pricingTier] || 0;
    const addonTotal = addonTotalForTier(pricingTier, allowedAddOns);
    const subtotal   = basePrice + addonTotal;

    const couponCodes = [];
    let discountAmount = 0;
    let running = subtotal;
    const rawCodes = [...new Set([].concat(req.body.couponCodes || []).filter(Boolean).map((c) => c.trim().toUpperCase()))].slice(0, MAX_COUPONS_PER_BOOKING);

    // Claimed atomically up front, in parallel with the manual-coupon lookups below (this fetch
    // doesn't depend on their result — only the final discount-amount math does). Claiming via
    // findOneAndUpdate rather than a plain read-then-flip-later means two concurrent submissions
    // from the same account can't both pass an eligibility check before either one claims it.
    const discountClaimPromise = (req.session.userId && subtotal > 0)
      ? User.findOneAndUpdate(
          { _id: req.session.userId, discountUsed: false, discountPercent: { $gt: 0 }, discountExpiresAt: { $gt: new Date() } },
          { discountUsed: true },
          { new: false }
        )
      : Promise.resolve(null);

    if (rawCodes.length && subtotal > 0) {
      for (const rawCode of rawCodes) {
        if (rawCode === SIGNUP_DISCOUNT_CODE) continue; // reserved — never a real, admin-created Coupon
        const coupon = await Coupon.findOne({ code: rawCode, active: true });
        if (!coupon || (coupon.expiresAt && new Date() > coupon.expiresAt)) continue;
        const amount = coupon.discountType === "percent"
          ? calcPercentDiscount(running, coupon.discountValue)
          : Math.min(coupon.discountValue, running);
        couponCodes.push({ code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue, amount });
        discountAmount += amount;
        running -= amount;
      }
    }

    // Auto-apply the signup welcome discount (if claimed above) on top of any manually entered
    // coupons. If it turns out to be worth $0 (e.g. a manual coupon already zeroed the subtotal)
    // or the booking save below fails, the claim is released again so the one-time discount isn't
    // wasted for no benefit.
    const claimedDiscount = await discountClaimPromise;
    if (claimedDiscount) {
      const amount = calcPercentDiscount(running, claimedDiscount.discountPercent);
      if (amount > 0) {
        couponCodes.push({ code: SIGNUP_DISCOUNT_CODE, discountType: "percent", discountValue: claimedDiscount.discountPercent, amount });
        discountAmount += amount;
        running -= amount;
        claimedDiscountUserId = claimedDiscount._id;
      } else {
        await User.updateOne({ _id: claimedDiscount._id }, { discountUsed: false });
      }
    }

    const booking = new BookingRequest({
      crCode: req.crCode,
      visitorId: req.visitorId,
      name,
      email,
      location,
      clientType,
      serviceType,
      pricingTier,
      addOns: allowedAddOns,
      budget: pricingTier === "Custom" ? budget : undefined,
      projectBrief,
      mediaLinks,
      platforms,
      tosAgreedAt: new Date(),
      emailConsent,
      uploadedFiles,
      couponCodes,
      discountAmount,
    });

    await booking.save();
    writeBookingTxt(booking);

    // Auto-link booking to logged-in user and send them straight to the dashboard
    if (req.session.userId) {
      try {
        booking.clientId = req.session.userId;
        await booking.save();
        const linkedUser = await User.findById(req.session.userId);
        if (linkedUser) {
          const alreadyLinked = linkedUser.bookings.some(id => id.toString() === booking._id.toString());
          if (!alreadyLinked) {
            linkedUser.bookings.push(booking._id);
            await linkedUser.save();
          }
        }
      } catch (linkErr) {
        console.error("Error linking booking to user:", linkErr);
      }
      sendBookingConfirmation(booking);
      sendAdminNewBookingAlert(booking);
      notifyAdminNewBooking(booking);
      return res.redirect(`/dashboard?submitted=${booking.crCode}`);
    }

    sendBookingConfirmation(booking);
    sendAdminNewBookingAlert(booking);
    notifyAdminNewBooking(booking);

    res.redirect(`/hire/success?cr=${booking.crCode}`);
  } catch (err) {
    console.error("Booking save error:", err);
    if (claimedDiscountUserId) {
      await User.updateOne({ _id: claimedDiscountUserId }, { discountUsed: false }).catch(() => {});
    }
    res.render("public/hire", {
      error: "Something went wrong saving your request. Please try again.",
      formData: req.body,
    });
  }
});

router.post("/career/apply", enforceApplicationSubmissionQuota, preAppCode, (req, res, next) => {
  applicationUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "That file exceeds the 200MB limit." : err.message || "Upload failed.";
    return res.status(400).json({ ok: false, error: message });
  });
}, async (req, res) => {
  const { name, email, message, roleId } = req.body;

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailRe.test(email) || !message || message.length > 2000) {
    return res.status(400).json({ ok: false, error: "Please fill in all required fields." });
  }

  let role = null;
  if (roleId) {
    role = await Role.findOne({ _id: roleId, active: true });
    if (!role) return res.status(400).json({ ok: false, error: "That role is no longer open." });
  }

  try {
    const file = req.file
      ? {
          originalName: req.file.originalname,
          storedName: req.file.filename,
          size: req.file.size,
          mimetype: req.file.mimetype,
          folder: fileTypeFromMime(req.file.mimetype),
          storageKey: req.file.storageKey,
          backend: req.file.backend,
          blurDataUrl: await generateBlurDataUrl(req.file.buffer, req.file.mimetype),
        }
      : undefined;

    const application = new Application({
      appCode: req.appCode,
      visitorId: req.visitorId,
      roleId: role?._id || null,
      roleTitle: role?.title || "General Application",
      name,
      email,
      message,
      file,
    });
    await application.save();

    sendAdminNewApplicationAlert(application);

    res.json({ ok: true });
  } catch (err) {
    console.error("Application save error:", err);
    res.status(500).json({ ok: false, error: "Something went wrong saving your application. Please try again." });
  }
});

router.get("/track/:crCode/deliverables/:filename", async (req, res) => {
  const crCode = req.params.crCode.toUpperCase().trim();
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({ crCode, "deliverableFiles.storedName": filename });
  if (!booking || !booking.deliverablesUnlocked) return res.sendStatus(403);
  const fileInfo = booking.deliverableFiles.find(f => f.storedName === filename);
  if (await redirectToStoredFile(res, booking.crCode, deliverableDiskFolder(), filename, fileInfo)) return;
  res.sendStatus(404);
});

router.routes = [
  { method: "GET", path: "/", label: "Landing page" },
  { method: "GET", path: "/career", label: "Careers page" },
  { method: "GET", path: "/terms", label: "Terms of service" },
  { method: "GET", path: "/track", label: "Track a project" },
  { method: "GET", path: "/go/:crCode", label: "Email link: project page or tracking page" },
  { method: "GET", path: "/hire", label: "Booking form" },
  { method: "GET", path: "/hire/success", label: "Booking submitted" },
  { method: "POST", path: "/hire/coupon/validate", label: "Check a coupon code" },
  { method: "POST", path: "/hire", label: "Submit a booking" },
  { method: "POST", path: "/career/apply", label: "Submit a job application" },
  { method: "GET", path: "/track/:crCode/deliverables/:filename", label: "Download final files from the tracking page" },
];

module.exports = router;
