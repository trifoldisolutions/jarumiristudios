const fs = require("fs");
const path = require("path");

function fileTypeFromMime(mimetype) {
  if (/^video\//i.test(mimetype)) return "video";
  if (/^audio\//i.test(mimetype)) return "audio";
  if (/^image\//i.test(mimetype)) return "image";
  return "other";
}

function uniqueFilename(originalname) {
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  return `${unique}${path.extname(originalname)}`;
}

// Moves a booking's local uploads/<crCode> folder into uploads/_archive/<crCode> — the same
// move both admin archive routes and the automated overdue-archive checks use. Doesn't touch
// the caller's `archived` DB flag or R2 objects (R2 keys are flat by crCode, unaffected by
// active/archived state); fire-and-forget like the routes it was extracted from.
function archiveBookingFolder(crCode) {
  if (!crCode) return;
  const archiveDir = path.join(__dirname, "..", "uploads", "_archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.rename(path.join(__dirname, "..", "uploads", crCode), path.join(archiveDir, crCode), () => {});
}

module.exports = { fileTypeFromMime, uniqueFilename, archiveBookingFolder };
