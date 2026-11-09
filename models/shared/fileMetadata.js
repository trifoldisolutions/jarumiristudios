// Shared subdocument shape for every place a file's metadata is stored (BookingRequest's
// uploadedFiles/deliverableFiles, Message's attachment/attachments) — one place to add a
// field (e.g. storageKey/backend for the R2 migration) instead of three.
const mongoose = require("mongoose");

module.exports = {
  originalName: String,
  storedName: String,
  size: Number,
  mimetype: String,
  // Logical category the file belongs to — "raws" (client-submitted), "deliverables", or "chat"
  // (untagged chat attachment). Both storage backends resolve this to the same physical
  // subfolder shape via chatDiskFolder/deliverableDiskFolder/diskFolderFor in services/storage.js:
  // <crCode>/raws/, <crCode>/finals/, <crCode>/chats/clients|associate/.
  folder: String,
  // Full object key once uploaded to R2 (e.g. "<crCode>/raws/<storedName>"). Unset for files
  // still on the local `backend`. Older documents may carry a flat legacy key
  // ("<crCode>/<storedName>") from before folder was encoded in the key — reads always use
  // this stored value directly rather than recomputing it, so those keep resolving unchanged.
  storageKey: String,
  // Which storage backend actually holds the bytes for this file — drives read-path branching
  // during the phased R2 migration. Defaults to "local" so existing documents need no backfill.
  backend: { type: String, enum: ["local", "r2"], default: "local" },
  // Attribution only (which associate, or null for the shared admin login, uploaded a
  // deliverable) — no longer affects where the file is physically stored. Chat attachments get
  // their uploader from the parent Message's senderRole/senderAssociateId instead.
  uploadedByAssociateId: { type: mongoose.Schema.Types.ObjectId, ref: "Associate", default: null },
  // Tiny base64 blurred preview (images only).
  blurDataUrl: String,
};
