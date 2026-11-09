const express = require("express");
const path = require("path");
const fs = require("fs");
const BookingRequest = require("../models/BookingRequest");
const Notification = require("../models/Notification");
const AssociateNotification = require("../models/AssociateNotification");
const Message = require("../models/Message");
const LoginAttempt = require("../models/LoginAttempt");
const Associate = require("../models/Associate");
const { CHAT_MAX_ATTACHMENTS, LOGIN_MAX_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS } = require("../config/limits");
const { ADDON_PRICES } = require("../config/pricing");
const { requireAssociate, requireAssignedBooking } = require("../middleware/auth");
const { deliverableUpload, chatUpload } = require("../middleware/upload");
const { fileTypeFromMime } = require("../services/uploadUtils");
const { deleteObject } = require("../services/r2");
const { io, chatRoom } = require("../services/chatSocket");
const { BOOKING_STATUSES, STATUS_GATE_HINTS, STATUS_GATE_TERMINAL_HINT, isStatusChangeAllowed, getStatusGate, notifyStatusChange } = require("../services/bookingStatus");
const { createDepositInvoice, reissueDepositInvoice, createFinalInvoice, reissueFinalInvoice, createRevisionInvoice } = require("../services/invoices");
const { deliverableDiskFolder, chatDiskFolder, diskFolderFor, redirectToStoredFile, moveStoredFile, generateBlurDataUrl } = require("../services/storage");
const { messageAttachments, softDeleteMessage, buildReplySnapshot, resolveTaggedAttachments, unclaimedChatUnlockedBookingIds, associateMessageThreads } = require("../services/messages");
const { isRateLimited } = require("../services/rateLimit");

const router = express.Router();

// Inject unread client-message count into all /associate views (this associate's own
// assigned bookings, plus unclaimed ones every associate should see — unlike the admin-wide count).
router.use(async (req, res, next) => {
  res.locals.associateUnreadMessageCount = 0;
  res.locals.associateUnreadNotifCount = 0;
  if (req.session.associateId) {
    try {
      const [assignedIds, unclaimedIds] = await Promise.all([
        BookingRequest.find({ assignedTo: req.session.associateId, archived: { $ne: true } }).distinct("_id"),
        unclaimedChatUnlockedBookingIds(),
      ]);
      const bookingIds = assignedIds.concat(unclaimedIds);
      const [unreadMessages, unreadNotifs] = await Promise.all([
        Message.countDocuments({ bookingId: { $in: bookingIds }, senderRole: "client", read: false }),
        AssociateNotification.countDocuments({ associateId: req.session.associateId, read: false }),
      ]);
      res.locals.associateUnreadMessageCount = unreadMessages;
      res.locals.associateUnreadNotifCount = unreadNotifs;
    } catch {}
  }
  next();
});

// ── Associate auth (separate from both the client account system and the shared-password
// admin login — individual email+password accounts, created only via /admin/associates) ──
router.get("/login", (req, res) => {
  if (req.session.associateId) return res.redirect("/associate");
  res.render("associate/login");
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const attemptKey = `associate:${email?.trim().toLowerCase() || ""}`;

  if (await isRateLimited(attemptKey, LOGIN_MAX_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS)) {
    return res.render("associate/login", { error: "Too many failed attempts. Please try again in a few minutes." });
  }

  const associate = await Associate.findOne({ email: email?.trim().toLowerCase() });
  if (!associate || !associate.active || !(await associate.verifyPassword(password))) {
    await LoginAttempt.create({ key: attemptKey });
    return res.render("associate/login", { error: "Invalid email or password." });
  }
  await LoginAttempt.deleteMany({ key: attemptKey });
  req.session.associateId = associate._id.toString();
  res.redirect("/associate");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/associate/login"));
});

// ── Associate portal ──
router.get("/", requireAssociate, async (req, res) => {
  const [myProjects, unclaimed] = await Promise.all([
    BookingRequest.find({ assignedTo: req.session.associateId, archived: false }).sort({ updatedAt: -1 }),
    BookingRequest.find({ assignedTo: null, archived: false }).sort({ createdAt: -1 }),
  ]);
  res.render("associate/dashboard", { myProjects, unclaimed, claimError: req.query.claimError || null });
});

// Atomic claim — two editors racing the same unclaimed booking only ever lets one through.
router.post("/booking/:id/claim", requireAssociate, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, assignedTo: null, archived: false },
    { assignedTo: req.session.associateId },
    { new: true }
  );
  if (!booking) return res.redirect(`/associate?claimError=${encodeURIComponent("That project has already been claimed.")}`);
  res.redirect(`/associate/booking/${booking._id}`);
});

router.get("/booking/:id", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  const messages = booking.clientId ? await Message.find({ bookingId: booking._id }).sort({ createdAt: 1 }) : [];
  if (booking.clientId) await Message.updateMany({ bookingId: booking._id, senderRole: "client", read: false }, { read: true });
  res.render("associate/booking", {
    booking,
    messages,
    statusGate: getStatusGate(booking.status),
    statusGateHints: STATUS_GATE_HINTS,
    statusGateTerminalHint: STATUS_GATE_TERMINAL_HINT,
    statusError: req.query.statusError || null,
    stripeError: req.query.error || null,
    deliverError: req.query.deliverError || null,
    delivered: req.query.delivered ? parseInt(req.query.delivered, 10) : null,
  });
});

router.post("/booking/:id/revision/:revId/reviewed", requireAssociate, requireAssignedBooking, async (req, res) => {
  await BookingRequest.updateOne(
    { _id: req.params.id, "revisions._id": req.params.revId },
    { $set: { "revisions.$.status": "reviewed" } }
  );
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/status", requireAssociate, requireAssignedBooking, async (req, res) => {
  const existing = req.booking;
  if (existing.status === req.body.status) return res.redirect(`/associate/booking/${req.params.id}`);
  if (!BOOKING_STATUSES.includes(req.body.status) || !isStatusChangeAllowed(existing.status, req.body.status)) {
    return res.redirect(`/associate/booking/${req.params.id}?statusError=${encodeURIComponent("That status change isn't allowed yet.")}`);
  }
  const booking = await BookingRequest.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (booking) await notifyStatusChange([booking], req.body.status);
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/deliverables", requireAssociate, requireAssignedBooking, (req, res, next) => {
  deliverableUpload.array("files", 20)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE" ? "You can upload up to 20 files at a time."
      : err.message || "Upload failed.";
    res.redirect(`/associate/booking/${req.params.id}?deliverError=${encodeURIComponent(message)}`);
  });
}, async (req, res) => {
  const newFiles = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname,
    storedName: f.filename,
    size: f.size,
    mimetype: f.mimetype,
    folder: "deliverables",
    uploadedByAssociateId: req.session.associateId,
    storageKey: f.storageKey,
    backend: f.backend,
    blurDataUrl: await generateBlurDataUrl(f.buffer, f.mimetype),
  })));
  if (newFiles.length === 0) {
    return res.redirect(`/associate/booking/${req.params.id}?deliverError=${encodeURIComponent("No files were selected.")}`);
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
  res.redirect(`/associate/booking/${req.params.id}?delivered=${newFiles.length}`);
});

router.post("/booking/:id/deliverables/:fileId/delete", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  const file = booking.deliverableFiles.id(req.params.fileId);
  if (file) {
    if (file.backend === "r2") {
      await deleteObject(file.storageKey).catch((err) => console.error("R2 delete error:", err.message));
    } else {
      fs.rm(path.join(__dirname, "..", "uploads", booking.crCode, deliverableDiskFolder(), file.storedName), { force: true }, () => {});
    }
    booking.deliverableFiles.pull(req.params.fileId);
    await booking.save();
  }
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/deposit-due-date", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  if (booking.depositStatus !== "pending") return res.redirect(`/associate/booking/${req.params.id}`);
  try {
    await reissueDepositInvoice(booking, req.body.dueDate);
  } catch (err) {
    console.error("Stripe deposit due-date update error:", err.message);
    return res.redirect(`/associate/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/delivery-date", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  if (booking.depositStatus !== "paid") return res.redirect(`/associate/booking/${req.params.id}`);
  if (req.body.deliveryDate) {
    const parsed = new Date(`${req.body.deliveryDate}T00:00:00`);
    if (!isNaN(parsed.getTime())) booking.deliveryDate = parsed;
  } else {
    booking.deliveryDate = null;
  }
  await booking.save();
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/final-due-date", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  if (booking.finalPaymentStatus !== "pending") return res.redirect(`/associate/booking/${req.params.id}`);
  try {
    await reissueFinalInvoice(booking, req.body.dueDate);
  } catch (err) {
    console.error("Stripe final due-date update error:", err.message);
    return res.redirect(`/associate/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/send-deposit", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  if (booking.depositStatus !== "none") return res.redirect(`/associate/booking/${req.params.id}`);
  try {
    await createDepositInvoice(booking, parseFloat(req.body.agreedPrice), req.body.dueDate);
  } catch (err) {
    console.error("Stripe deposit invoice error:", err.message);
    return res.redirect(`/associate/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/send-final", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  if (booking.depositStatus !== "paid" || booking.finalPaymentStatus !== "none") return res.redirect(`/associate/booking/${req.params.id}`);
  try {
    await createFinalInvoice(booking, req.body.dueDate);
  } catch (err) {
    console.error("Stripe final invoice error:", err.message);
    return res.redirect(`/associate/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.post("/booking/:id/send-revision-invoice", requireAssociate, requireAssignedBooking, async (req, res) => {
  const booking = req.booking;
  if (!booking.stripeCustomerId) return res.redirect(`/associate/booking/${req.params.id}`);
  try {
    await createRevisionInvoice(booking, parseFloat(req.body.amount) || ADDON_PRICES["Extra revision"], req.body.dueDate);
  } catch (err) {
    console.error("Stripe revision invoice error:", err.message);
    return res.redirect(`/associate/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/associate/booking/${req.params.id}`);
});

router.get("/messages", requireAssociate, async (req, res) => {
  const threads = await associateMessageThreads(req.session.associateId, { archivedOnly: false });
  res.render("associate/messages", { threads, archivedView: false });
});

router.get("/messages/archived", requireAssociate, async (req, res) => {
  const threads = await associateMessageThreads(req.session.associateId, { archivedOnly: true });
  res.render("associate/messages", { threads, archivedView: true });
});

router.get("/messages/:id", requireAssociate, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, assignedTo: req.session.associateId });
  if (!booking) return res.redirect("/associate/messages");
  const messages = await Message.find({ bookingId: booking._id }).sort({ createdAt: 1 });
  if (booking.clientId) await Message.updateMany({ bookingId: booking._id, senderRole: "client", read: false }, { read: true });

  if (req.xhr) {
    return res.render("associate/partials/message-thread-panel-rich", {
      booking, messages, myRole: "admin",
      attachmentBasePath: "/associate/messages/attachments",
      postPath: `/associate/booking/${booking._id}/messages`,
    });
  }

  const threads = await associateMessageThreads(req.session.associateId, { archivedOnly: !!booking.archived });
  res.render("associate/messages", { threads, booking, messages, archivedView: !!booking.archived });
});

router.get("/notifications", requireAssociate, async (req, res) => {
  const notifications = await AssociateNotification.find({ associateId: req.session.associateId }).sort({ createdAt: -1 }).limit(200);
  await AssociateNotification.updateMany({ associateId: req.session.associateId, read: false }, { read: true });
  res.locals.associateUnreadNotifCount = 0;
  res.render("associate/notifications", { notifications });
});

router.post("/booking/:id/messages", requireAssociate, requireAssignedBooking, (req, res, next) => {
  chatUpload.array("attachments", CHAT_MAX_ATTACHMENTS)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const booking = req.booking;
  if (!booking.clientId) return res.status(400).json({ error: "This project has no linked client account." });
  if (!booking.chatUnlocked) return res.status(403).json({ error: "This project hasn't been accepted yet." });
  if (booking.chatBlocked) return res.status(403).json({ error: "Unblock this client to send a message." });

  const body = (req.body.body || "").trim();
  const attachments = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname, storedName: f.filename, size: f.size, mimetype: f.mimetype, folder: "chat",
    storageKey: f.storageKey, backend: f.backend,
    blurDataUrl: await generateBlurDataUrl(f.buffer, f.mimetype),
  })));
  const tagged = resolveTaggedAttachments(booking, req.body.taggedFiles, false);
  if (tagged === null) return res.status(400).json({ error: "One of those files couldn't be found." });
  attachments.push(...tagged);

  if (!body && attachments.length === 0) return res.status(400).json({ error: "Message can't be empty." });

  const replyTo = await buildReplySnapshot(req.params.id, req.body.replyToMessageId);

  const message = await Message.create({
    bookingId: req.params.id,
    crCode: booking.crCode,
    clientId: booking.clientId,
    senderRole: "admin",
    senderAssociateId: req.session.associateId,
    body,
    attachments,
    replyTo,
  });

  const payload = message.toObject();
  payload.chatBlocked = booking.chatBlocked;
  io.to(chatRoom(req.params.id)).emit("new-message", payload);
  res.json({ message });
});

router.post("/booking/:id/messages/:messageId/delete", requireAssociate, requireAssignedBooking, async (req, res) => {
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: req.params.id, senderRole: "admin" });
  if (!message) return res.status(404).json({ error: "Message not found." });
  await softDeleteMessage(message);
  io.to(chatRoom(req.params.id)).emit("message-deleted", { messageId: message._id, bookingId: req.params.id });
  res.json({ ok: true });
});

router.post("/booking/:id/messages/:messageId/edit", requireAssociate, requireAssignedBooking, async (req, res) => {
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

// Mutes the client on this project's chat — same as the admin toggle, scoped to the associate's
// own assigned booking (see requireAssignedBooking).
router.post("/booking/:id/chat-block", requireAssociate, requireAssignedBooking, async (req, res) => {
  req.booking.chatBlocked = true;
  await req.booking.save();
  res.json({ ok: true, chatBlocked: true });
});

router.post("/booking/:id/chat-unblock", requireAssociate, requireAssignedBooking, async (req, res) => {
  req.booking.chatBlocked = false;
  await req.booking.save();
  res.json({ ok: true, chatBlocked: false });
});

// Associate equivalent of the admin save-to-project route — promotes a chat-shared file into
// the booking's official uploadedFiles, scoped to bookings assigned to this associate.
router.post("/messages/attachments/:filename/save-to-project", requireAssociate, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({ $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }] });
  if (!message) return res.sendStatus(404);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  if (att.folder && att.folder !== "chat") return res.status(400).json({ error: "Already in project files." });

  const booking = await BookingRequest.findOne({ _id: message.bookingId, assignedTo: req.session.associateId });
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

router.get("/messages/attachments/:filename", requireAssociate, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({ $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }] });
  if (!message) return res.sendStatus(404);
  const booking = await BookingRequest.findOne({ _id: message.bookingId, assignedTo: req.session.associateId });
  if (!booking) return res.sendStatus(404);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  // See the matching comment on the /admin/messages/attachments route in routes/admin.js.
  if (message.senderRole !== "admin" && !att.downloaded && req.query.downloaded === "1") {
    att.downloaded = true;
    await message.save();
  }
  if (await redirectToStoredFile(res, message.crCode, diskFolderFor(att, message.senderRole), filename, att)) return;
  res.sendStatus(404);
});

router.get("/uploads/:filename", requireAssociate, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    assignedTo: req.session.associateId,
    $or: [{ "uploadedFiles.storedName": filename }, { "deliverableFiles.storedName": filename }],
  });
  if (!booking) return res.sendStatus(404);
  const uploadedMatch = booking.uploadedFiles.find(f => f.storedName === filename);
  const fileDoc = uploadedMatch || booking.deliverableFiles.find(f => f.storedName === filename);
  const folder = uploadedMatch ? (fileDoc.folder || fileTypeFromMime(fileDoc.mimetype)) : deliverableDiskFolder();
  if (await redirectToStoredFile(res, booking.crCode, folder, filename, fileDoc)) return;
  res.sendStatus(404);
});

router.routes = [
  { method: "GET", path: "/login", label: "Associate log in" },
  { method: "POST", path: "/login", label: "Associate log in (form)" },
  { method: "GET", path: "/logout", label: "Associate log out" },
  { method: "GET", path: "/", label: "Associate dashboard" },
  { method: "POST", path: "/booking/:id/claim", label: "Claim a project" },
  { method: "GET", path: "/booking/:id", label: "Project page" },
  { method: "POST", path: "/booking/:id/revision/:revId/reviewed", label: "Mark a revision reviewed" },
  { method: "POST", path: "/booking/:id/status", label: "Change a project's status" },
  { method: "POST", path: "/booking/:id/deliverables", label: "Upload final files" },
  { method: "POST", path: "/booking/:id/deliverables/:fileId/delete", label: "Delete a final file" },
  { method: "POST", path: "/booking/:id/deposit-due-date", label: "Move the deposit due date" },
  { method: "POST", path: "/booking/:id/delivery-date", label: "Set the delivery date" },
  { method: "POST", path: "/booking/:id/final-due-date", label: "Move the final due date" },
  { method: "POST", path: "/booking/:id/send-deposit", label: "Send the deposit invoice" },
  { method: "POST", path: "/booking/:id/send-final", label: "Send the final invoice" },
  { method: "POST", path: "/booking/:id/send-revision-invoice", label: "Send a revision invoice" },
  { method: "GET", path: "/messages", label: "Chat inbox" },
  { method: "GET", path: "/messages/archived", label: "Archived chat inbox" },
  { method: "GET", path: "/messages/:id", label: "Chat thread" },
  { method: "GET", path: "/notifications", label: "Associate notifications" },
  { method: "POST", path: "/booking/:id/messages", label: "Send a chat message" },
  { method: "POST", path: "/booking/:id/messages/:messageId/delete", label: "Delete a chat message" },
  { method: "POST", path: "/booking/:id/messages/:messageId/edit", label: "Edit a chat message" },
  { method: "POST", path: "/booking/:id/chat-block", label: "Mute the client on a project's chat" },
  { method: "POST", path: "/booking/:id/chat-unblock", label: "Unmute the client on a project's chat" },
  { method: "POST", path: "/messages/attachments/:filename/save-to-project", label: "Save a chat attachment to the project" },
  { method: "GET", path: "/messages/attachments/:filename", label: "Download a chat attachment" },
  { method: "GET", path: "/uploads/:filename", label: "Download a project's file" },
];

module.exports = router;
