const express = require("express");
const path = require("path");
const fs = require("fs");
const BookingRequest = require("../models/BookingRequest");
const Coupon = require("../models/Coupon");
const Notification = require("../models/Notification");
const AdminNotification = require("../models/AdminNotification");
const AssociateNotification = require("../models/AssociateNotification");
const Message = require("../models/Message");
const LoginAttempt = require("../models/LoginAttempt");
const Role = require("../models/Role");
const Associate = require("../models/Associate");
const { CHAT_MAX_ATTACHMENTS, LOGIN_MAX_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS } = require("../config/limits");
const { TIER_PRICES, ADDON_PRICES, SIGNUP_DISCOUNT_CODE, PRICING_TIERS, SERVICE_TYPES } = require("../config/pricing");
const { requireAdmin } = require("../middleware/auth");
const { deliverableUpload, chatUpload, attachCrCode } = require("../middleware/upload");
const { fileTypeFromMime, archiveBookingFolder } = require("../services/uploadUtils");
const { deleteObject } = require("../services/r2");
const { io, chatRoom } = require("../services/chatSocket");
const { endOfDay, monthKeysBetween, monthKeyLabel } = require("../services/dates");
const { STATUS_LABELS, BOOKING_STATUSES, STATUS_GATE_HINTS, STATUS_GATE_TERMINAL_HINT, isStatusChangeAllowed, getStatusGate, PIPELINE_STATUS_ORDER, notifyStatusChange } = require("../services/bookingStatus");
const { createDepositInvoice, reissueDepositInvoice, createFinalInvoice, reissueFinalInvoice, createRevisionInvoice } = require("../services/invoices");
const { deliverableDiskFolder, chatDiskFolder, diskFolderFor, redirectToStoredFile, moveStoredFile, generateBlurDataUrl } = require("../services/storage");
const { escapeHtml } = require("../services/bookings");
const { messageAttachments, softDeleteMessage, buildReplySnapshot, resolveTaggedAttachments, adminMessageThreads } = require("../services/messages");
const { isRateLimited } = require("../services/rateLimit");

const router = express.Router();

// ── Admin routes ──

// Inject unread admin notification count into all /admin views
router.use(async (req, res, next) => {
  res.locals.adminUnreadCount = 0;
  if (req.session.isAdmin) {
    try {
      res.locals.adminUnreadCount = await AdminNotification.countDocuments({ read: false });
    } catch {}
  }
  next();
});

router.get("/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.render("admin/login");
});

router.post("/login", async (req, res) => {
  const attemptKey = `admin:${req.visitorId}`;

  if (await isRateLimited(attemptKey, LOGIN_MAX_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS)) {
    return res.render("admin/login", { error: "Too many failed attempts. Please try again in a few minutes." });
  }

  if (req.body.password === process.env.ADMIN_PASSWORD) {
    await LoginAttempt.deleteMany({ key: attemptKey });
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  await LoginAttempt.create({ key: attemptKey });
  res.render("admin/login", { error: "Incorrect password." });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

router.get("/notifications", requireAdmin, async (req, res) => {
  const notifications = await AdminNotification.find().sort({ createdAt: -1 }).limit(200);
  await AdminNotification.updateMany({ read: false }, { read: true });
  res.locals.adminUnreadCount = 0;
  res.render("admin/notifications", { notifications });
});

const ADMIN_PAGE_SIZE = 30;

const ADMIN_SEARCH_FIELDS = {
  crCode: "crCode",
  name: "name",
  email: "email",
  location: "location",
  services: "serviceType",
  package: "pricingTier",
  status: "status",
};

router.get("/", requireAdmin, async (req, res) => {
  const archivedView = req.query.view === "archived";
  const completedView = req.query.view === "completed";
  const filter = archivedView
    ? { archived: true }
    : completedView
    ? { archived: { $ne: true }, status: "completed" }
    : { archived: { $ne: true } };

  // Status narrows within the Archived tab too (e.g. a deposit-expiry auto-decline is both
  // declined and archived) — completedView is excluded since that tab is already status-locked.
  const statusParam = (req.query.status || "all").trim();
  if (!completedView && statusParam !== "all") {
    const statuses = statusParam.split(",").filter(Boolean);
    if (statuses.length) filter.status = { $in: statuses };
  }

  const q = (req.query.q || "").trim();
  const field = ADMIN_SEARCH_FIELDS[req.query.field] ? req.query.field : "all";
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = field === "all"
      ? Object.values(ADMIN_SEARCH_FIELDS).map((f) => ({ [f]: re }))
      : [{ [ADMIN_SEARCH_FIELDS[field]]: re }];
  }

  const dateFrom = (req.query.dateFrom || "").trim();
  const dateTo = (req.query.dateTo || "").trim();
  const fromDate = dateFrom ? new Date(`${dateFrom}T00:00:00Z`) : null;
  const toDate = endOfDay(dateTo);
  if ((fromDate && !isNaN(fromDate.getTime())) || toDate) {
    filter.createdAt = {};
    if (fromDate && !isNaN(fromDate.getTime())) filter.createdAt.$gte = fromDate;
    if (toDate) filter.createdAt.$lte = toDate;
  }

  const total = await BookingRequest.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(req.query.page) || 1), totalPages);

  const bookings = await BookingRequest.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * ADMIN_PAGE_SIZE)
    .limit(ADMIN_PAGE_SIZE)
    .populate("assignedTo", "name");

  const locals = {
    bookings, total, TIER_PRICES, ADDON_PRICES, archivedView, completedView,
    page, totalPages, pageSize: ADMIN_PAGE_SIZE, q, field, statusParam, STATUS_LABELS,
    dateFrom, dateTo,
  };

  if (req.xhr) {
    res.render("admin/partials/filter-summary", locals, (err, summaryHtml) => {
      if (err) return res.status(500).end();
      res.render("admin/partials/results-table", locals, (err2, tableHtml) => {
        if (err2) return res.status(500).end();
        res.json({ summaryHtml, tableHtml });
      });
    });
    return;
  }

  res.render("admin/dashboard", locals);
});

router.get("/analytics", requireAdmin, async (req, res) => {
  const dateFrom = (req.query.dateFrom || "").trim();
  const dateTo = (req.query.dateTo || "").trim();

  const defaultFrom = new Date();
  defaultFrom.setUTCDate(1);
  defaultFrom.setUTCHours(0, 0, 0, 0);
  defaultFrom.setUTCMonth(defaultFrom.getUTCMonth() - 11);

  const fromDate = (dateFrom && !isNaN(new Date(`${dateFrom}T00:00:00Z`).getTime()))
    ? new Date(`${dateFrom}T00:00:00Z`)
    : defaultFrom;
  const toDate = endOfDay(dateTo) || new Date();

  const [facetResult] = await BookingRequest.aggregate([
    { $match: { archived: { $ne: true }, createdAt: { $gte: fromDate, $lte: toDate } } },
    {
      $addFields: {
        revenue: {
          $add: [
            { $cond: [{ $eq: ["$depositStatus", "paid"] }, { $multiply: [{ $ifNull: ["$agreedPrice", 0] }, 0.3] }, 0] },
            { $cond: [{ $eq: ["$finalPaymentStatus", "paid"] }, { $multiply: [{ $ifNull: ["$agreedPrice", 0] }, 0.7] }, 0] },
          ],
        },
        trustGroup: { $cond: [{ $ne: ["$clientId", null] }, "account", "guest"] },
        // Exclude the auto-applied signup discount (code "WELCOME") from coupon-usage stats —
        // it's not a manually-entered promo code, so it shouldn't inflate "used a coupon" metrics.
        realCouponCodes: { $filter: { input: { $ifNull: ["$couponCodes", []] }, as: "c", cond: { $ne: ["$$c.code", SIGNUP_DISCOUNT_CODE] } } },
      },
    },
    {
      $addFields: {
        hasCoupon: { $cond: [{ $gt: [{ $size: "$realCouponCodes" }, 0] }, 1, 0] },
        realCouponDiscount: { $sum: "$realCouponCodes.amount" },
      },
    },
    {
      $facet: {
        byMonth: [
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 }, revenue: { $sum: "$revenue" } } },
        ],
        byTier: [
          { $group: { _id: "$pricingTier", revenue: { $sum: "$revenue" }, count: { $sum: 1 } } },
        ],
        byService: [
          { $unwind: "$serviceType" },
          { $group: { _id: "$serviceType", count: { $sum: 1 } } },
        ],
        funnel: [
          { $group: {
              _id: null,
              total: { $sum: 1 },
              depositPaid: { $sum: { $cond: [{ $eq: ["$depositStatus", "paid"] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          } },
        ],
        byTrust: [
          { $group: {
              _id: "$trustGroup",
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          } },
        ],
        coupon: [
          { $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              couponBookings: { $sum: "$hasCoupon" },
              totalDiscount: { $sum: "$realCouponDiscount" },
          } },
        ],
        dealSize: [
          { $match: { agreedPrice: { $gt: 0 } } },
          { $group: { _id: null, avgPrice: { $avg: "$agreedPrice" } } },
        ],
        revenueTotal: [
          { $group: { _id: null, total: { $sum: "$revenue" } } },
        ],
      },
    },
  ]);

  const monthKeys = monthKeysBetween(fromDate, toDate);
  const byMonthMap = new Map(facetResult.byMonth.map((r) => [r._id, r]));
  const bookingsPerMonth = monthKeys.map((key) => ({
    label: monthKeyLabel(key),
    value: byMonthMap.get(key)?.count || 0,
  }));
  const revenuePerMonth = monthKeys.map((key) => ({
    label: monthKeyLabel(key),
    value: Math.round(byMonthMap.get(key)?.revenue || 0),
  }));

  const byTierMap = new Map(facetResult.byTier.map((r) => [r._id, r]));
  const revenueByTier = PRICING_TIERS.map((tier) => ({
    label: tier,
    value: Math.round(byTierMap.get(tier)?.revenue || 0),
  }));

  const byServiceMap = new Map(facetResult.byService.map((r) => [r._id, r]));
  const bookingsByService = SERVICE_TYPES.map((service) => ({
    label: service,
    value: byServiceMap.get(service)?.count || 0,
  }));

  const funnel = facetResult.funnel[0] || { total: 0, depositPaid: 0, completed: 0 };

  const byTrustMap = new Map(facetResult.byTrust.map((r) => [r._id, r]));
  const trustGroups = ["guest", "account"].map((g) => {
    const row = byTrustMap.get(g) || { total: 0, completed: 0 };
    return {
      label: g === "guest" ? "Guest" : "Account holder",
      total: row.total,
      completed: row.completed,
      rate: row.total ? Math.round((row.completed / row.total) * 100) : 0,
    };
  });

  const couponStats = facetResult.coupon[0] || { totalBookings: 0, couponBookings: 0, totalDiscount: 0 };
  const avgDealSize = facetResult.dealSize[0]?.avgPrice || 0;
  const revenueCollected = Math.round(facetResult.revenueTotal[0]?.total || 0);

  const pipelineRaw = await BookingRequest.aggregate([
    { $match: { archived: { $ne: true } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const pipelineMap = new Map(pipelineRaw.map((r) => [r._id, r.count]));
  const pipelineSnapshot = PIPELINE_STATUS_ORDER.map((status) => ({
    label: STATUS_LABELS[status] || status,
    value: pipelineMap.get(status) || 0,
  }));

  res.render("admin/analytics", {
    dateFrom: dateFrom || fromDate.toISOString().slice(0, 10),
    dateTo: dateTo || toDate.toISOString().slice(0, 10),
    kpi: {
      totalBookings: funnel.total,
      revenueCollected,
      avgDealSize: Math.round(avgDealSize),
      conversionRate: funnel.total ? Math.round((funnel.completed / funnel.total) * 100) : 0,
    },
    bookingsPerMonth,
    revenuePerMonth,
    revenueByTier,
    bookingsByService,
    funnel,
    trustGroups,
    couponStats,
    pipelineSnapshot,
  });
});

router.get("/booking/:id", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking) return res.redirect("/admin");
  const associates = await Associate.find({ active: true }).sort({ name: 1 });
  res.render("admin/booking", {
    booking,
    associates,
    statusGate: getStatusGate(booking.status),
    statusGateHints: STATUS_GATE_HINTS,
    statusGateTerminalHint: STATUS_GATE_TERMINAL_HINT,
    statusError: req.query.statusError || null,
    stripeError: req.query.error || null,
    deliverError: req.query.deliverError || null,
    delivered: req.query.delivered ? parseInt(req.query.delivered, 10) : null,
  });
});

router.post("/booking/:id/messages", requireAdmin, async (req, res, next) => {
  const booking = await BookingRequest.findById(req.params.id).select("crCode archived clientId uploadedFiles deliverableFiles status chatBlocked");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  if (booking.archived) return res.status(403).json({ error: "This project is archived." });
  if (!booking.clientId) return res.status(400).json({ error: "This project has no linked client account." });
  if (!booking.chatUnlocked) return res.status(403).json({ error: "This project hasn't been accepted yet." });
  if (booking.chatBlocked) return res.status(403).json({ error: "Unblock this client to send a message." });
  req.crCode = booking.crCode;
  req.booking = booking;
  next();
}, (req, res, next) => {
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
  const tagged = resolveTaggedAttachments(req.booking, req.body.taggedFiles, false);
  if (tagged === null) return res.status(400).json({ error: "One of those files couldn't be found." });
  attachments.push(...tagged);

  if (!body && attachments.length === 0) return res.status(400).json({ error: "Message can't be empty." });

  const replyTo = await buildReplySnapshot(req.params.id, req.body.replyToMessageId);

  const message = await Message.create({
    bookingId: req.params.id,
    crCode: req.booking.crCode,
    clientId: req.booking.clientId,
    senderRole: "admin",
    body,
    attachments,
    replyTo,
  });

  // chatBlocked rides along so the client's page can reconcile its composer lock state against
  // the current mute status on every message, instead of only at page load (see views/partials/message-thread-script.ejs).
  const payload = message.toObject();
  payload.chatBlocked = req.booking.chatBlocked;
  io.to(chatRoom(req.params.id)).emit("new-message", payload);
  res.json({ message });
});

router.post("/booking/:id/messages/:messageId/delete", requireAdmin, async (req, res) => {
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: req.params.id, senderRole: "admin" });
  if (!message) return res.status(404).json({ error: "Message not found." });
  await softDeleteMessage(message);
  io.to(chatRoom(req.params.id)).emit("message-deleted", { messageId: message._id, bookingId: req.params.id });
  res.json({ ok: true });
});

router.post("/booking/:id/messages/:messageId/edit", requireAdmin, async (req, res) => {
  const body = (req.body.body || "").trim();
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: req.params.id, senderRole: "admin", deleted: false });
  if (!message) return res.status(404).json({ error: "Message not found." });
  if (!body && messageAttachments(message).length === 0) return res.status(400).json({ error: "Message can't be empty." });
  message.body = body;
  message.edited = true;
  await message.save();
  io.to(chatRoom(req.params.id)).emit("message-edited", { messageId: message._id, bookingId: req.params.id, body: message.body });
  res.json({ message });
});

// Mutes the client on this project's chat — they keep read access to the thread but can't send.
// Independent of chatUnlocked (project-phase gating): the admin can block regardless of status.
// JSON response (not a redirect) since this is triggered from within the chat panel via fetch,
// same as the other in-thread actions (delete message, cancel download).
router.post("/booking/:id/chat-block", requireAdmin, async (req, res) => {
  await BookingRequest.findByIdAndUpdate(req.params.id, { chatBlocked: true });
  res.json({ ok: true, chatBlocked: true });
});

router.post("/booking/:id/chat-unblock", requireAdmin, async (req, res) => {
  await BookingRequest.findByIdAndUpdate(req.params.id, { chatBlocked: false });
  res.json({ ok: true, chatBlocked: false });
});

router.get("/messages", requireAdmin, async (req, res) => {
  const threads = await adminMessageThreads({ archivedOnly: false });
  res.render("admin/messages", { threads, archivedView: false });
});

router.get("/messages/archived", requireAdmin, async (req, res) => {
  const threads = await adminMessageThreads({ archivedOnly: true });
  res.render("admin/messages", { threads, archivedView: true });
});

router.get("/messages/:id", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: { $ne: null } });
  if (!booking) return res.redirect("/admin/messages");
  const messages = await Message.find({ bookingId: booking._id }).sort({ createdAt: 1 });
  await Message.updateMany({ bookingId: booking._id, senderRole: "client", read: false }, { read: true });

  if (req.xhr) {
    return res.render("admin/partials/message-thread-panel", {
      booking, messages, myRole: "admin",
      attachmentBasePath: "/admin/messages/attachments",
      postPath: `/admin/booking/${booking._id}/messages`,
    });
  }

  const threads = await adminMessageThreads({ archivedOnly: !!booking.archived });
  res.render("admin/messages", { threads, booking, messages, archivedView: !!booking.archived });
});

router.get("/messages/attachments/:filename", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({ $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }] });
  if (!message) return res.sendStatus(404);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  // req.query.downloaded distinguishes an actual download/open from the file-viewer's sidebar
  // grid silently pre-fetching thumbnails for every project file (see views/partials/message-thread-script.ejs
  // renderViewerGrid) — only the former should flip the "downloaded" indicator the sender sees.
  if (message.senderRole !== "admin" && !att.downloaded && req.query.downloaded === "1") {
    att.downloaded = true;
    await message.save();
  }
  if (await redirectToStoredFile(res, message.crCode, diskFolderFor(att, message.senderRole), filename, att)) return;
  res.sendStatus(404);
});

// Promotes a chat-shared file (uploaded fresh in the composer, not tagged from existing project
// files) into the booking's official uploadedFiles — moves it out of files/chat/ into the
// matching files/<type>/ subfolder and updates the message's own record of where it lives.
router.post("/messages/attachments/:filename/save-to-project", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({ $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }] });
  if (!message) return res.sendStatus(404);
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

router.post("/booking/:id/status", requireAdmin, async (req, res) => {
  const existing = await BookingRequest.findById(req.params.id).select("status");
  if (!existing) return res.redirect("/admin");
  if (existing.status === req.body.status) return res.redirect(`/admin/booking/${req.params.id}`);
  if (!BOOKING_STATUSES.includes(req.body.status) || !isStatusChangeAllowed(existing.status, req.body.status)) {
    return res.redirect(`/admin/booking/${req.params.id}?statusError=${encodeURIComponent("That status change isn't allowed yet.")}`);
  }

  const booking = await BookingRequest.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status },
    { new: true }
  );
  if (booking) await notifyStatusChange([booking], req.body.status);
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/bookings/bulk-status", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  const status = req.body.status;
  if (ids.length && BOOKING_STATUSES.includes(status)) {
    const candidates = await BookingRequest.find(
      { _id: { $in: ids }, status: { $ne: status } },
      "clientId crCode deliverableFiles status pricingTier"
    );
    const bookings = candidates.filter((b) => isStatusChangeAllowed(b.status, status));
    if (bookings.length) {
      await BookingRequest.updateMany({ _id: { $in: bookings.map((b) => b._id) } }, { status });
      await notifyStatusChange(bookings, status);
    }
  }
  res.redirect("/admin");
});

router.post("/booking/:id/deliverables", requireAdmin, attachCrCode, (req, res, next) => {
  deliverableUpload.array("files", 20)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE" ? "You can upload up to 20 files at a time."
      : err.message || "Upload failed.";
    res.redirect(`/admin/booking/${req.params.id}?deliverError=${encodeURIComponent(message)}`);
  });
}, async (req, res) => {
  const newFiles = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname,
    storedName: f.filename,
    size: f.size,
    mimetype: f.mimetype,
    folder: "deliverables",
    storageKey: f.storageKey,
    backend: f.backend,
    blurDataUrl: await generateBlurDataUrl(f.buffer, f.mimetype),
  })));
  if (newFiles.length === 0) {
    return res.redirect(`/admin/booking/${req.params.id}?deliverError=${encodeURIComponent("No files were selected.")}`);
  }
  const booking = await BookingRequest.findByIdAndUpdate(
    req.params.id,
    { $push: { deliverableFiles: { $each: newFiles } } },
    { new: true }
  );
  if (booking && booking.clientId && booking.status === "completed") {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "deliverable_ready",
      message: `Your final files are ready to download for project ${booking.crCode}.`,
    });
  }
  res.redirect(`/admin/booking/${req.params.id}?delivered=${newFiles.length}`);
});

router.post("/booking/:id/deliverables/:fileId/delete", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (booking && !booking.archived) {
    const file = booking.deliverableFiles.id(req.params.fileId);
    if (file) {
      if (file.backend === "r2") {
        await deleteObject(file.storageKey).catch((err) => console.error("R2 delete error:", err.message));
      } else {
        const deliverableFolder = deliverableDiskFolder();
        fs.rm(path.join(__dirname, "..", "uploads", booking.crCode, deliverableFolder, file.storedName), { force: true }, () => {});
        fs.rm(path.join(__dirname, "..", "uploads", "_archive", booking.crCode, deliverableFolder, file.storedName), { force: true }, () => {});
      }
      booking.deliverableFiles.pull(req.params.fileId);
      await booking.save();
    }
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/notes", requireAdmin, async (req, res) => {
  const text = (req.body.note || "").trim();
  if (text) {
    await BookingRequest.findByIdAndUpdate(req.params.id, { $push: { adminNotes: { text } } });
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/notes/:noteId/delete", requireAdmin, async (req, res) => {
  await BookingRequest.findByIdAndUpdate(req.params.id, { $pull: { adminNotes: { _id: req.params.noteId } } });
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/notes/:noteId/edit", requireAdmin, async (req, res) => {
  const text = (req.body.text || "").trim();
  if (text) {
    await BookingRequest.updateOne(
      { _id: req.params.id, "adminNotes._id": req.params.noteId },
      { $set: { "adminNotes.$.text": text } }
    );
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/send-deposit", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "none") return res.redirect(`/admin/booking/${req.params.id}`);
  try {
    await createDepositInvoice(booking, parseFloat(req.body.agreedPrice), req.body.dueDate);
  } catch (err) {
    console.error("Stripe deposit invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/deposit-due-date", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "pending") return res.redirect(`/admin/booking/${req.params.id}`);
  try {
    await reissueDepositInvoice(booking, req.body.dueDate);
  } catch (err) {
    console.error("Stripe deposit due-date update error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/delivery-date", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "paid") return res.redirect(`/admin/booking/${req.params.id}`);

  if (req.body.deliveryDate) {
    const parsed = new Date(`${req.body.deliveryDate}T00:00:00`);
    if (!isNaN(parsed.getTime())) booking.deliveryDate = parsed;
  } else {
    booking.deliveryDate = null;
  }
  await booking.save();
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/send-final", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "paid" || booking.finalPaymentStatus !== "none") {
    return res.redirect(`/admin/booking/${req.params.id}`);
  }
  try {
    await createFinalInvoice(booking, req.body.dueDate);
  } catch (err) {
    console.error("Stripe final invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/send-revision-invoice", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.archived || !booking.stripeCustomerId) {
    return res.redirect(`/admin/booking/${req.params.id}`);
  }
  try {
    await createRevisionInvoice(booking, parseFloat(req.body.amount) || ADDON_PRICES["Extra revision"], req.body.dueDate);
  } catch (err) {
    console.error("Stripe revision invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/final-due-date", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.finalPaymentStatus !== "pending") return res.redirect(`/admin/booking/${req.params.id}`);
  try {
    await reissueFinalInvoice(booking, req.body.dueDate);
  } catch (err) {
    console.error("Stripe final due-date update error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.post("/booking/:id/archive", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (booking && booking.clientId) {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "project_dismissed",
      message: `Project ${booking.crCode} has been archived.`,
    });
  }
  await BookingRequest.findByIdAndUpdate(req.params.id, { archived: true });
  archiveBookingFolder(booking?.crCode);
  res.redirect("/admin");
});

router.post("/bookings/bulk-archive", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  if (ids.length) {
    const bookings = await BookingRequest.find({ _id: { $in: ids } }, "clientId crCode _id");
    const notifications = bookings
      .filter(b => b.clientId)
      .map(b => ({
        userId: b.clientId,
        bookingId: b._id,
        crCode: b.crCode,
        type: "project_dismissed",
        message: `Project ${b.crCode} has been archived.`,
      }));
    if (notifications.length) await Notification.insertMany(notifications);
    await BookingRequest.updateMany({ _id: { $in: ids } }, { archived: true });
    bookings.forEach((b) => archiveBookingFolder(b.crCode));
  }
  res.redirect("/admin");
});

router.post("/booking/:id/restore", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, filesDeleted: { $ne: true } },
    { archived: false }
  );
  if (booking?.crCode) {
    const archiveDir = path.join(__dirname, "..", "uploads", "_archive");
    fs.rename(path.join(archiveDir, booking.crCode), path.join(__dirname, "..", "uploads", booking.crCode), () => {});
  }
  res.redirect("/admin");
});

router.post("/booking/:id/revision/:revId/reviewed", requireAdmin, async (req, res) => {
  await BookingRequest.updateOne(
    { _id: req.params.id, "revisions._id": req.params.revId },
    { $set: { "revisions.$.status": "reviewed" } }
  );
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.get("/uploads/:filename", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    $or: [{ "uploadedFiles.storedName": filename }, { "deliverableFiles.storedName": filename }],
  });
  if (booking) {
    const uploadedMatch = booking.uploadedFiles.find(f => f.storedName === filename);
    const fileDoc = uploadedMatch || booking.deliverableFiles.find(f => f.storedName === filename);
    const folder = uploadedMatch ? (fileDoc.folder || fileTypeFromMime(fileDoc.mimetype)) : deliverableDiskFolder();
    if (await redirectToStoredFile(res, booking.crCode, folder, filename, fileDoc)) return;
  }
  res.sendFile(path.join(__dirname, "..", "uploads", filename));
});

// ── Admin coupon routes ──
router.get("/coupons", requireAdmin, async (req, res) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.render("admin/coupons", { coupons });
});

router.post("/coupons", requireAdmin, async (req, res) => {
  const { code, discountType, discountValue, expiresAt } = req.body;
  if ((code || "").trim().toUpperCase() === SIGNUP_DISCOUNT_CODE) {
    console.error(`Coupon create error: "${SIGNUP_DISCOUNT_CODE}" is reserved for the signup welcome discount`);
    return res.redirect("/admin/coupons");
  }
  try {
    await new Coupon({ code, discountType, discountValue: parseFloat(discountValue), expiresAt: expiresAt || null }).save();
  } catch (err) {
    console.error("Coupon create error:", err.message);
  }
  res.redirect("/admin/coupons");
});

router.post("/coupons/:id/toggle", requireAdmin, async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (coupon) { coupon.active = !coupon.active; await coupon.save(); }
  res.redirect("/admin/coupons");
});

router.post("/coupons/:id/delete", requireAdmin, async (req, res) => {
  await Coupon.findByIdAndDelete(req.params.id);
  res.redirect("/admin/coupons");
});

router.get("/roles", requireAdmin, async (req, res) => {
  const roles = await Role.find().sort({ order: 1, createdAt: 1 });
  res.render("admin/roles", { roles });
});

router.post("/roles", requireAdmin, async (req, res) => {
  const { title, emoji, description, requirements, order } = req.body;
  try {
    await new Role({
      title,
      emoji,
      description,
      requirements: (requirements || "").split("\n").map((r) => r.trim()).filter(Boolean),
      order: parseInt(order, 10) || 0,
    }).save();
  } catch (err) {
    console.error("Role create error:", err.message);
  }
  res.redirect("/admin/roles");
});

router.post("/roles/:id/toggle", requireAdmin, async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (role) { role.active = !role.active; await role.save(); }
  res.redirect("/admin/roles");
});

router.post("/roles/:id/delete", requireAdmin, async (req, res) => {
  await Role.findByIdAndDelete(req.params.id);
  res.redirect("/admin/roles");
});

// ── Associate accounts (superadmin-managed editors) — no delete route: BookingRequest.assignedTo
// can reference an Associate, so deactivating avoids orphaned refs, same reasoning as Coupons. ──
router.get("/associates", requireAdmin, async (req, res) => {
  const associates = await Associate.find().sort({ createdAt: -1 });
  res.render("admin/associates", { associates });
});

router.post("/associates", requireAdmin, async (req, res) => {
  const { name, email, password } = req.body;
  try {
    await new Associate({ name, email, password }).save();
  } catch (err) {
    console.error("Associate create error:", err.message);
  }
  res.redirect("/admin/associates");
});

router.post("/associates/:id/toggle", requireAdmin, async (req, res) => {
  const associate = await Associate.findById(req.params.id);
  if (associate) { associate.active = !associate.active; await associate.save(); }
  res.redirect("/admin/associates");
});

router.post("/associates/:id/reset-password", requireAdmin, async (req, res) => {
  const associate = await Associate.findById(req.params.id);
  if (associate && req.body.password) {
    associate.password = req.body.password;
    await associate.save();
  }
  res.redirect("/admin/associates");
});

// Superadmin can assign/reassign/unassign any booking at any time, independent of whether
// an editor has already self-claimed it.
router.post("/booking/:id/assign", requireAdmin, async (req, res) => {
  const newAssociateId = req.body.associateId || null;
  const booking = await BookingRequest.findByIdAndUpdate(req.params.id, { assignedTo: newAssociateId });
  if (booking && newAssociateId && newAssociateId !== booking.assignedTo?.toString()) {
    AssociateNotification.create({
      associateId: newAssociateId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "assignment",
      message: `You were assigned to project ${booking.crCode} (${escapeHtml(booking.name)}).`,
    }).catch((err) => console.error("Error creating associate assignment notification:", err.message));
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

router.routes = [
  { method: "GET", path: "/login", label: "Admin log in" },
  { method: "POST", path: "/login", label: "Admin log in (form)" },
  { method: "GET", path: "/logout", label: "Admin log out" },
  { method: "GET", path: "/notifications", label: "Admin notifications" },
  { method: "GET", path: "/", label: "Bookings dashboard" },
  { method: "GET", path: "/analytics", label: "Analytics" },
  { method: "GET", path: "/booking/:id", label: "Booking page" },
  { method: "POST", path: "/booking/:id/messages", label: "Send a chat message" },
  { method: "POST", path: "/booking/:id/messages/:messageId/delete", label: "Delete a chat message" },
  { method: "POST", path: "/booking/:id/messages/:messageId/edit", label: "Edit a chat message" },
  { method: "POST", path: "/booking/:id/chat-block", label: "Mute the client on a project's chat" },
  { method: "POST", path: "/booking/:id/chat-unblock", label: "Unmute the client on a project's chat" },
  { method: "GET", path: "/messages", label: "Chat inbox" },
  { method: "GET", path: "/messages/archived", label: "Archived chat inbox" },
  { method: "GET", path: "/messages/:id", label: "Chat thread" },
  { method: "GET", path: "/messages/attachments/:filename", label: "Download a chat attachment" },
  { method: "POST", path: "/messages/attachments/:filename/save-to-project", label: "Save a chat attachment to the project" },
  { method: "POST", path: "/booking/:id/status", label: "Change a booking's status" },
  { method: "POST", path: "/bookings/bulk-status", label: "Change the status of several bookings" },
  { method: "POST", path: "/booking/:id/deliverables", label: "Upload final files" },
  { method: "POST", path: "/booking/:id/deliverables/:fileId/delete", label: "Delete a final file" },
  { method: "POST", path: "/booking/:id/notes", label: "Add a note" },
  { method: "POST", path: "/booking/:id/notes/:noteId/delete", label: "Delete a note" },
  { method: "POST", path: "/booking/:id/notes/:noteId/edit", label: "Edit a note" },
  { method: "POST", path: "/booking/:id/send-deposit", label: "Send the deposit invoice" },
  { method: "POST", path: "/booking/:id/deposit-due-date", label: "Move the deposit due date" },
  { method: "POST", path: "/booking/:id/delivery-date", label: "Set the delivery date" },
  { method: "POST", path: "/booking/:id/send-final", label: "Send the final invoice" },
  { method: "POST", path: "/booking/:id/send-revision-invoice", label: "Send a revision invoice" },
  { method: "POST", path: "/booking/:id/final-due-date", label: "Move the final due date" },
  { method: "POST", path: "/booking/:id/archive", label: "Archive a booking" },
  { method: "POST", path: "/bookings/bulk-archive", label: "Archive several bookings" },
  { method: "POST", path: "/booking/:id/restore", label: "Restore an archived booking" },
  { method: "POST", path: "/booking/:id/revision/:revId/reviewed", label: "Mark a revision reviewed" },
  { method: "GET", path: "/uploads/:filename", label: "Download a booking's file" },
  { method: "GET", path: "/coupons", label: "Coupons" },
  { method: "POST", path: "/coupons", label: "Create a coupon" },
  { method: "POST", path: "/coupons/:id/toggle", label: "Turn a coupon on or off" },
  { method: "POST", path: "/coupons/:id/delete", label: "Delete a coupon" },
  { method: "GET", path: "/roles", label: "Job roles" },
  { method: "POST", path: "/roles", label: "Create a job role" },
  { method: "POST", path: "/roles/:id/toggle", label: "Turn a job role on or off" },
  { method: "POST", path: "/roles/:id/delete", label: "Delete a job role" },
  { method: "GET", path: "/associates", label: "Associates" },
  { method: "POST", path: "/associates", label: "Create an associate" },
  { method: "POST", path: "/associates/:id/toggle", label: "Turn an associate on or off" },
  { method: "POST", path: "/associates/:id/reset-password", label: "Reset an associate's password" },
  { method: "POST", path: "/booking/:id/assign", label: "Assign a booking to an associate" },
];

module.exports = router;
