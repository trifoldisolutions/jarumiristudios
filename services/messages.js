const fs = require("fs");
const path = require("path");
const BookingRequest = require("../models/BookingRequest");
const Message = require("../models/Message");
const User = require("../models/User");
const { deleteObject } = require("./r2");
const { chatDiskFolder } = require("./storage");

// Normalizes either shape a Message can carry — the legacy single `attachment` (messages sent
// before multi-attachment support) or the current `attachments` array — into a plain array.
function messageAttachments(m) {
  if (m.attachments && m.attachments.length) return m.attachments;
  if (m.attachment && m.attachment.storedName) return [m.attachment];
  return [];
}

// "Image"/"Audio"/"Video"/"File" label for a message preview — deliberately not the filename,
// which is meaningless out of context (thread-list rows, toasts) compared to just knowing what
// kind of file was sent.
function attachmentTypeLabel(mimetype) {
  if (/^video\//i.test(mimetype)) return "Video";
  if (/^audio\//i.test(mimetype)) return "Audio";
  if (/^image\//i.test(mimetype)) return "Image";
  return "File";
}

function messagePreview(body, attachments) {
  if (body) return body.length > 60 ? body.slice(0, 60) + "…" : body;
  if (attachments && attachments.length) {
    return attachments.length === 1 ? "📎 " + attachmentTypeLabel(attachments[0].mimetype) : "📎 " + attachments.length + " files";
  }
  return "";
}

// Soft-deletes a message: clears its body/attachments (leaving a tombstone the UI renders as
// "This message was deleted") and removes any chat-uploaded files from disk. Attachments tagged
// from a project's own files ("uploaded"/"video"/etc. folders, not "chat") are left on disk since
// they still belong to the project regardless of this message being deleted.
async function softDeleteMessage(message) {
  if (message.deleted) return;
  const chatAttachments = messageAttachments(message).filter((a) => (a.folder || "chat") === "chat");
  await Promise.all(chatAttachments.map(async (a) => {
    if (a.backend === "r2") {
      await deleteObject(a.storageKey).catch((err) => console.error("R2 delete error:", err.message));
      return;
    }
    const chatFolder = chatDiskFolder(message.senderRole);
    fs.rm(path.join(__dirname, "..", "uploads", message.crCode, chatFolder, a.storedName), { force: true }, () => {});
    fs.rm(path.join(__dirname, "..", "uploads", "_archive", message.crCode, chatFolder, a.storedName), { force: true }, () => {});
  }));
  message.deleted = true;
  message.body = "";
  message.attachment = undefined;
  message.attachments = [];
  await message.save();
}

// Snapshots the message being replied to at send time (not a live ref) so a later edit/delete of
// the original doesn't retroactively change what an existing reply shows. Returns undefined if no
// replyToMessageId was given, it doesn't belong to this booking, or it's already deleted.
async function buildReplySnapshot(bookingId, replyToMessageId) {
  if (!replyToMessageId) return undefined;
  const original = await Message.findOne({ _id: replyToMessageId, bookingId }).select("senderRole body deleted attachment attachments");
  if (!original || original.deleted) return undefined;
  const atts = messageAttachments(original);
  return {
    messageId: original._id,
    senderRole: original.senderRole,
    body: original.body || "",
    attachmentSummary: atts.length ? (atts.length === 1 ? attachmentTypeLabel(atts[0].mimetype) : atts.length + " files") : "",
  };
}

// Builds a chat attachment that references an already-uploaded project file instead of a fresh
// composer upload, so tagging a file in chat doesn't duplicate it on disk. Returns null if the
// file doesn't exist on the booking, or (for clients) if it's a deliverable that isn't unlocked yet.
function resolveTaggedAttachment(booking, source, fileId, isClient) {
  const arrayName = source === "deliverable" ? "deliverableFiles" : "uploadedFiles";
  const file = booking[arrayName]?.id(fileId);
  if (!file) return null;
  if (arrayName === "deliverableFiles" && isClient && !booking.deliverablesUnlocked) return null;
  const folder = arrayName === "deliverableFiles" ? "deliverables" : "raws";
  return {
    originalName: file.originalName,
    storedName: file.storedName,
    size: file.size,
    mimetype: file.mimetype,
    blurDataUrl: file.blurDataUrl,
    folder,
    // Carried forward so diskFolderFor can resolve this reference's on-disk path — only
    // populated when tagging an existing deliverable, undefined (and unused) otherwise.
    uploadedByAssociateId: arrayName === "deliverableFiles" ? file.uploadedByAssociateId : undefined,
  };
}

// Resolves a JSON-encoded list of { id, source } tag requests into attachment objects.
// Returns null (caller should 400) if the JSON is malformed or any referenced file can't be tagged.
function resolveTaggedAttachments(booking, taggedFilesJson, isClient) {
  if (!taggedFilesJson) return [];
  let items;
  try {
    items = JSON.parse(taggedFilesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const attachments = [];
  for (const item of items) {
    const att = resolveTaggedAttachment(booking, item?.source, item?.id, isClient);
    if (!att) return null;
    attachments.push(att);
  }
  return attachments;
}

async function adminMessageThreads({ archivedOnly = false } = {}) {
  const bookings = await BookingRequest.find({ clientId: { $ne: null }, archived: archivedOnly ? true : { $ne: true } })
    .select("crCode name serviceType status archived createdAt uploadedFiles.storedName uploadedFiles.mimetype")
    .sort({ createdAt: -1 });
  const threads = await Promise.all(bookings.map(async (booking) => {
    const [lastMessage, unreadCount] = await Promise.all([
      Message.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }),
      Message.countDocuments({ bookingId: booking._id, senderRole: "client", read: false }),
    ]);
    return { booking, lastMessage, unreadCount };
  }));
  // A booking only gets a row in the inbox once a conversation has actually
  // started — starting one now happens from the booking page, not from here.
  return threads.filter((t) => t.lastMessage);
}

// Projects nobody has claimed yet still have chat unlocked once accepted (chatUnlocked
// is purely status-based) — surface their unread client messages to every associate so
// one doesn't sit un-replied-to just because it hasn't been assigned.
async function unclaimedChatUnlockedBookingIds() {
  const candidates = await BookingRequest.find({ assignedTo: null, archived: { $ne: true } }).select("status");
  return candidates.filter((b) => b.chatUnlocked).map((b) => b._id);
}

async function associateMessageThreads(associateId, { archivedOnly = false } = {}) {
  const bookings = await BookingRequest.find({ assignedTo: associateId, clientId: { $ne: null }, archived: archivedOnly ? true : { $ne: true } })
    .select("crCode name serviceType status archived createdAt uploadedFiles.storedName uploadedFiles.mimetype")
    .sort({ createdAt: -1 });
  const threads = await Promise.all(bookings.map(async (booking) => {
    const [lastMessage, unreadCount] = await Promise.all([
      Message.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }),
      Message.countDocuments({ bookingId: booking._id, senderRole: "client", read: false }),
    ]);
    return { booking, lastMessage, unreadCount };
  }));
  // Only surface a thread once a conversation has actually started — starting one happens
  // from the booking page itself, not from this inbox.
  return threads.filter((t) => t.lastMessage);
}

async function clientMessageThreads(userId) {
  const user = await User.findById(userId).populate({
    path: "bookings",
    select: "crCode serviceType pricingTier status archived createdAt uploadedFiles.storedName uploadedFiles.mimetype",
    options: { sort: { createdAt: -1 } },
  });
  if (!user) return null;
  const activeBookings = (user.bookings || []).filter((booking) => !booking.archived);
  const threads = await Promise.all(activeBookings.map(async (booking) => {
    const [lastMessage, unreadCount] = await Promise.all([
      Message.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }),
      Message.countDocuments({ bookingId: booking._id, senderRole: "admin", read: false }),
    ]);
    return { booking, lastMessage, unreadCount };
  }));
  // A booking only gets a row in the inbox once a conversation has actually
  // started — starting one now happens from the booking page, not from here.
  return threads.filter((t) => t.lastMessage);
}

module.exports = { messageAttachments, messagePreview, softDeleteMessage, buildReplySnapshot, resolveTaggedAttachments, adminMessageThreads, unclaimedChatUnlockedBookingIds, associateMessageThreads, clientMessageThreads };
