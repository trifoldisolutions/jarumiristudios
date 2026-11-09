const multer = require("multer");
const BookingRequest = require("../models/BookingRequest");
const { createR2Storage } = require("../services/r2MulterStorage");
const { createLocalStorage } = require("../services/localMulterStorage");
const { chatDiskFolder, deliverableDiskFolder } = require("../services/storage");
const { generateCrCode, generateAppCode } = require("../services/codes");
const { MEMBER_MAX_FILE_SIZE, CHAT_ATTACHMENT_MAX_SIZE, APPLICATION_MAX_FILE_SIZE } = require("../config/limits");

// File upload (multer) — fileTypeFromMime/uniqueFilename live in services/uploadUtils.js now,
// shared with services/r2MulterStorage.js.

async function preCrCode(req, res, next) {
  try {
    req.crCode = await generateCrCode();
    next();
  } catch (err) {
    console.error("preCrCode failed:", err);
    res.render("public/hire", {
      error: "We couldn't process your request right now. Please try again in a moment.",
      loggedInUser: null,
      lastBooking: null,
    });
  }
}

async function preAppCode(req, res, next) {
  try {
    req.appCode = await generateAppCode();
    next();
  } catch (err) {
    console.error("preAppCode failed:", err);
    res.status(500).json({ ok: false, error: "We couldn't process your application right now. Please try again in a moment." });
  }
}

// Rejects file types that browsers will render/execute as an active document (HTML, SVG) when
// opened directly — served files are trusted by extension at request time regardless of the
// declared upload mimetype, so these must never be accepted no matter what mimetype is claimed.
const DANGEROUS_UPLOAD_EXT_RE = /\.(html?|xhtml|shtml|svg)$/i;
function rejectDangerousFiles(req, file, cb) {
  if (DANGEROUS_UPLOAD_EXT_RE.test(file.originalname)) {
    return cb(new Error("That file type isn't allowed."));
  }
  cb(null, true);
}

// Client-submitted files (the /hire form) are further restricted to an allowlist matching
// the upload widget's own `accept` attribute (video/audio/image, plus .zip/.rar for raw
// footage archives) — admin-uploaded deliverables stay on the blocklist above only, since
// admin is trusted to hand back whatever final file type a project actually needs.
const ALLOWED_UPLOAD_MIME_RE = /^(video|audio|image)\//i;
const ARCHIVE_UPLOAD_EXT_RE = /\.(zip|rar)$/i;
// Archive mimetypes are inconsistent across browsers/OSes; .rar in particular is commonly
// reported as the generic application/octet-stream, so that's only trusted alongside a
// matching .zip/.rar extension, never on its own.
const ARCHIVE_UPLOAD_MIME_RE = /^application\/(zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-rar|octet-stream)$/i;
function restrictToAllowedMediaTypes(req, file, cb) {
  rejectDangerousFiles(req, file, (err) => {
    if (err) return cb(err);
    const isMedia = ALLOWED_UPLOAD_MIME_RE.test(file.mimetype);
    const isArchive = ARCHIVE_UPLOAD_EXT_RE.test(file.originalname) && ARCHIVE_UPLOAD_MIME_RE.test(file.mimetype);
    if (!isMedia && !isArchive) {
      return cb(new Error("That file type isn't allowed. Upload video, audio, image, or .zip/.rar files."));
    }
    cb(null, true);
  });
}

// Job applications additionally accept PDF (resumes) on top of the video/audio/image/archive
// allowlist above — a portfolio piece is as likely to be a PDF deck as a video reel.
const APPLICATION_UPLOAD_MIME_RE = /^(video|audio|image|application\/pdf)/i;
function restrictToApplicationFileTypes(req, file, cb) {
  rejectDangerousFiles(req, file, (err) => {
    if (err) return cb(err);
    const isMedia = APPLICATION_UPLOAD_MIME_RE.test(file.mimetype);
    const isArchive = ARCHIVE_UPLOAD_EXT_RE.test(file.originalname) && ARCHIVE_UPLOAD_MIME_RE.test(file.mimetype);
    if (!isMedia && !isArchive) {
      return cb(new Error("That file type isn't allowed. Upload video, audio, image, PDF, or .zip/.rar files."));
    }
    cb(null, true);
  });
}

// All four multer instances below write straight to R2 (see services/r2MulterStorage.js) instead of
// local disk when not in dev — both engines now share the same key/path shape,
// `<crCode>/<folder>/<storedName>` (chats/clients, chats/associate, raws, finals), computed per
// instance below via each engine's getFolder callback.
//
// Locally, STORAGE_BACKEND=local (set in the gitignored .env, never present in the deployed
// environment's own config) switches all of them to disk instead — so dev doesn't depend on
// live R2 credentials/network, and browsers don't hit R2's presigned-URL CORS restrictions
// when downloading.
const USE_LOCAL_STORAGE = process.env.STORAGE_BACKEND === "local";
const upload = multer({
  storage: USE_LOCAL_STORAGE ? createLocalStorage(undefined, () => "raws") : createR2Storage(undefined, () => "raws"),
  limits: { fileSize: MEMBER_MAX_FILE_SIZE },
  fileFilter: restrictToAllowedMediaTypes,
});
// For a booking turned down after multer has already stored its files (see enforceFreeTierGates).
function discardUploadedFiles(req) {
  return Promise.all((req.files || []).map((file) => new Promise((resolve) => {
    upload.storage._removeFile(req, file, (err) => {
      if (err) console.error("Error removing an uploaded file:", err.message);
      resolve();
    });
  })));
}

// Admin-uploaded final deliverables — separate multer instance so they never mix with client-submitted raw files.
const deliverableUpload = multer({
  storage: USE_LOCAL_STORAGE ? createLocalStorage(undefined, deliverableDiskFolder) : createR2Storage(undefined, deliverableDiskFolder),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB
  fileFilter: rejectDangerousFiles,
});

// Chat attachments — quick references/previews, not raw footage delivery (that's what the
// main upload system above is for), so a smaller cap than member uploads.
// req.session.userId is only ever set for a client session (admin/associate sessions use
// isAdmin/associateId instead), matching how Message.senderRole ends up set for the message
// this file attaches to.
const chatUploadFolder = (req) => chatDiskFolder(req.session?.userId ? "client" : "admin");
const chatUpload = multer({
  storage: USE_LOCAL_STORAGE ? createLocalStorage(undefined, chatUploadFolder) : createR2Storage(undefined, chatUploadFolder),
  limits: { fileSize: CHAT_ATTACHMENT_MAX_SIZE },
  fileFilter: restrictToAllowedMediaTypes,
});

// Job application portfolio/work-sample upload — single file, keyed under req.appCode
// (set by preAppCode) instead of req.crCode since applications aren't bookings.
const applicationUpload = multer({
  storage: USE_LOCAL_STORAGE ? createLocalStorage((req) => req.appCode, () => "applications") : createR2Storage((req) => req.appCode),
  limits: { fileSize: APPLICATION_MAX_FILE_SIZE },
  fileFilter: restrictToApplicationFileTypes,
});

// Also blocks uploads to an archived booking — its folder lives under uploads/_archive/, not the active path,
// so writing here before a restore would split the booking's files across both locations
async function attachCrCode(req, res, next) {
  const booking = await BookingRequest.findById(req.params.id).select("crCode archived");
  if (!booking) return res.redirect("/admin");
  if (booking.archived) return res.redirect(`/admin/booking/${req.params.id}`);
  req.crCode = booking.crCode;
  next();
}

// Client-side equivalent of attachCrCode above — also verifies the booking belongs to the
// logged-in client before any multer disk write happens.
async function attachCrCodeForClient(req, res, next) {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId }).select("crCode archived chatBlocked clientId name uploadedFiles deliverableFiles status");
  if (!booking) return res.sendStatus(403);
  if (booking.archived) return res.sendStatus(403);
  if (!booking.chatUnlocked) return res.status(403).json({ error: "Chat opens once this project is accepted." });
  if (booking.chatBlocked) return res.status(403).json({ error: "You've been restricted from sending messages on this project." });
  req.crCode = booking.crCode;
  req.booking = booking;
  next();
}

module.exports = { preCrCode, preAppCode, upload, discardUploadedFiles, deliverableUpload, chatUpload, applicationUpload, attachCrCode, attachCrCodeForClient };
