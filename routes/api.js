const express = require("express");
const BookingRequest = require("../models/BookingRequest");
const Notification = require("../models/Notification");
const AdminNotification = require("../models/AdminNotification");
const AssociateNotification = require("../models/AssociateNotification");
const Message = require("../models/Message");
const { requireAdmin, requireClient, requireAssociate } = require("../middleware/auth");
const { messageAttachments, messagePreview, unclaimedChatUnlockedBookingIds } = require("../services/messages");

const router = express.Router();

router.get("/admin/notifications/poll", requireAdmin, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [unreadCount, items] = await Promise.all([
    AdminNotification.countDocuments({ read: false }),
    since
      ? AdminNotification.find({ createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  res.json({ unreadCount, items, now: Date.now() });
});

router.post("/admin/notifications/mark-read", requireAdmin, async (req, res) => {
  await AdminNotification.updateMany({ read: false }, { read: true });
  res.json({ ok: true });
});

router.get("/associate/notifications/poll", requireAssociate, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [unreadCount, items] = await Promise.all([
    AssociateNotification.countDocuments({ associateId: req.session.associateId, read: false }),
    since
      ? AssociateNotification.find({ associateId: req.session.associateId, createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  res.json({ unreadCount, items, now: Date.now() });
});

router.post("/associate/notifications/mark-read", requireAssociate, async (req, res) => {
  await AssociateNotification.updateMany({ associateId: req.session.associateId, read: false }, { read: true });
  res.json({ ok: true });
});

router.get("/associate/messages/poll", requireAssociate, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [assignedIds, unclaimedIds] = await Promise.all([
    BookingRequest.find({ assignedTo: req.session.associateId, archived: { $ne: true } }).distinct("_id"),
    unclaimedChatUnlockedBookingIds(),
  ]);
  const unclaimedSet = new Set(unclaimedIds.map(String));
  const bookingIds = assignedIds.concat(unclaimedIds);
  const [associateUnreadMessageCount, newMessages] = await Promise.all([
    Message.countDocuments({ bookingId: { $in: bookingIds }, senderRole: "client", read: false }),
    since
      ? Message.find({ bookingId: { $in: bookingIds }, senderRole: "client", createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  const messageItems = newMessages.map((m) => ({
    bookingId: m.bookingId,
    crCode: m.crCode,
    preview: messagePreview(m.body, messageAttachments(m)),
    unclaimed: unclaimedSet.has(String(m.bookingId)),
  }));
  res.json({ associateUnreadMessageCount, messageItems, now: Date.now() });
});

router.get("/notifications/poll", requireClient, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [unreadCount, unreadMessageCount, items, newMessages] = await Promise.all([
    Notification.countDocuments({ userId: req.session.userId, read: false }),
    Message.countDocuments({ clientId: req.session.userId, senderRole: "admin", read: false }),
    since
      ? Notification.find({ userId: req.session.userId, createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
    since
      ? Message.find({ clientId: req.session.userId, senderRole: "admin", createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  const messageItems = newMessages.map((m) => ({
    bookingId: m.bookingId,
    crCode: m.crCode,
    preview: messagePreview(m.body, messageAttachments(m)),
  }));
  res.json({ unreadCount, unreadMessageCount, items, messageItems, now: Date.now() });
});

router.post("/notifications/mark-read", requireClient, async (req, res) => {
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.json({ ok: true });
});

router.routes = [
  { method: "GET", path: "/admin/notifications/poll", label: "Poll admin notifications" },
  { method: "POST", path: "/admin/notifications/mark-read", label: "Mark admin notifications read" },
  { method: "GET", path: "/associate/notifications/poll", label: "Poll associate notifications" },
  { method: "POST", path: "/associate/notifications/mark-read", label: "Mark associate notifications read" },
  { method: "GET", path: "/associate/messages/poll", label: "Poll associate chat messages" },
  { method: "GET", path: "/notifications/poll", label: "Poll client notifications and messages" },
  { method: "POST", path: "/notifications/mark-read", label: "Mark client notifications read" },
];

module.exports = router;
