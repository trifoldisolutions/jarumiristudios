const mongoose = require("mongoose");
const fileMetadataFields = require("./shared/fileMetadata");

const attachmentFields = {
  ...fileMetadataFields,
  // Set once the non-sending party has actually fetched the file (see the attachment-serving
  // GET routes), so a re-render (page reload, new socket push) doesn't re-hide a file the
  // receiver already chose to download.
  downloaded: { type: Boolean, default: false },
};

const messageSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest", required: true, index: true },
    crCode: { type: String, required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderRole: { type: String, enum: ["admin", "client"], required: true },
    // Which specific associate account sent this (senderRole "admin" covers both the one
    // shared admin login and every associate — they're otherwise indistinguishable). Null for
    // the shared admin login and for client messages.
    senderAssociateId: { type: mongoose.Schema.Types.ObjectId, ref: "Associate", default: null },
    body: { type: String, trim: true, maxlength: 4000, default: "" },
    // Legacy single-attachment shape, kept so messages sent before multi-attachment
    // support still render — new messages are always written to `attachments` below.
    attachment: attachmentFields,
    attachments: [attachmentFields],
    read: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    edited: { type: Boolean, default: false },
    // Frozen at send time (not a live-populated ref) so a later edit/delete of the original
    // doesn't retroactively change what an existing reply shows — see buildReplySnapshot in services/messages.js.
    replyTo: {
      messageId: { type: mongoose.Schema.Types.ObjectId },
      senderRole: { type: String, enum: ["admin", "client"] },
      body: { type: String },
      attachmentSummary: { type: String },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
