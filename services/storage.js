const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { getPresignedDownloadUrl, deleteObject, copyObject, deleteObjectsByPrefixExcept } = require("./r2");

// Maps a file's logical DB `folder` (kept as a stable metadata value: "chat", "deliverables", or
// a tagged project file's own folder) to its physical storage path, shared by both the local-disk
// and R2 backends (see services/localMulterStorage.js / services/r2MulterStorage.js). Chat is split by
// whether the sender was the client or staff (admin/associate share one "associate" bucket —
// no per-account split); deliverables and raw project files are flat, single shared folders.
function chatDiskFolder(senderRole) {
  return senderRole === "client" ? "chats/clients" : "chats/associate";
}
function deliverableDiskFolder() {
  return "finals";
}
// Resolves the actual storage subfolder for an attachment: chat and deliverable attachments get
// the sender-split paths above, everything else (tagged project files) keeps its own `folder`
// as-is. senderRole is the parent Message's — irrelevant for a tagged deliverable reference (see
// resolveTaggedAttachment).
function diskFolderFor(att, senderRole) {
  const folder = att.folder || "chat";
  if (folder === "chat") return chatDiskFolder(senderRole);
  if (folder === "deliverables") return deliverableDiskFolder();
  return folder;
}

// Serves a stored file's bytes given its Mongo metadata subdoc: a presigned redirect for the
// R2 backend (using its stored `storageKey` directly — works for both old flat-keyed and new
// nested-keyed docs, since the key is never recomputed), or the on-disk lookup (active path,
// then _archive) for local-backend files. `fileDoc` is the uploadedFiles/deliverableFiles/
// attachment subdocument itself.
async function redirectToStoredFile(res, crCode, folder, filename, fileDoc) {
  if (fileDoc?.backend === "r2" && fileDoc.storageKey) {
    const url = await getPresignedDownloadUrl(fileDoc.storageKey);
    res.redirect(302, url);
    return true;
  }
  const activePath = path.join(__dirname, "..", "uploads", crCode, folder, filename);
  if (fs.existsSync(activePath)) { res.sendFile(activePath); return true; }
  const archivePath = path.join(__dirname, "..", "uploads", "_archive", crCode, folder, filename);
  if (fs.existsSync(archivePath)) { res.sendFile(archivePath); return true; }
  return false;
}

// Moves a stored file from one logical folder to another, e.g. promoting a chat attachment into
// a booking's project files. R2-backed files now encode folder in the key, so this is a real
// server-side copy to the new key followed by deleting the old one (fileDoc.storageKey is
// updated in place so the caller's subsequent save persists the new key). Local-backed files
// use the original disk rename, checking the active path then the _archive path and staying
// within whichever one the file is actually found in.
async function moveStoredFile(crCode, fromFolder, toFolder, filename, fileDoc) {
  if (fileDoc?.backend === "r2") {
    const newKey = `${crCode}/${toFolder}/${filename}`;
    await copyObject(fileDoc.storageKey, newKey);
    await deleteObject(fileDoc.storageKey);
    fileDoc.storageKey = newKey;
    return true;
  }
  for (const base of [path.join(__dirname, "..", "uploads", crCode), path.join(__dirname, "..", "uploads", "_archive", crCode)]) {
    const from = path.join(base, fromFolder, filename);
    if (fs.existsSync(from)) {
      const toDir = path.join(base, toFolder);
      fs.mkdirSync(toDir, { recursive: true });
      fs.renameSync(from, path.join(toDir, filename));
      return true;
    }
  }
  return false;
}

// A file just written by multer can briefly be held open (by Windows Defender's on-write scan,
// in observed testing) — retrying a couple of times a beat apart clears it without giving up
// on files that are only transiently busy, not actually stuck.
function retrySync(fn, attempts = 4, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

// Permanently removes a booking's client-submitted media (raw uploads, chat attachments) while
// keeping booking.txt and the delivered final files as a record — deliverables live in their own
// "finals" subfolder, so skipping it here is what keeps them intact.
// Synchronous and awaited-in-order by archiveAndWipeBookingFiles below — the async fire-and-forget
// version of this raced the folder rename that follows it (rm still mid-flight on the booking's
// subtree when rename tried to move the parent folder), which intermittently lost the race and
// left the folder sitting in the active uploads/ path, wiped but never archived.
function hardDeleteBookingFiles(crCode) {
  if (!crCode) return;
  for (const base of [path.join(__dirname, "..", "uploads", crCode), path.join(__dirname, "..", "uploads", "_archive", crCode)]) {
    if (!fs.existsSync(base)) continue;
    for (const folder of fs.readdirSync(base)) {
      if (folder === "finals") continue;
      fs.rmSync(path.join(base, folder), { recursive: true, force: true });
    }
  }
}

// Client-initiated "delete" — unlike admin archive (which just hides a project, files intact
// and restorable), this is meant to be irreversible for everything except delivered final
// files: raw uploads and chat attachments are wiped, but deliverables are kept on record so
// there's still proof of what was actually handed over. Only the booking.txt record and the
// deliverables survive, tucked into _archive alongside admin-archived projects.
async function archiveAndWipeBookingFiles(crCode, deliverableStorageKeys = []) {
  if (!crCode) return;
  try {
    retrySync(() => hardDeleteBookingFiles(crCode));
    // R2 keys are flat (`<crCode>/<storedName>`), so one prefix covers every uploaded file,
    // deliverable, and chat attachment for this booking — deliverableStorageKeys is excluded
    // from the batch-delete so those specific objects survive.
    await deleteObjectsByPrefixExcept(`${crCode}/`, deliverableStorageKeys);
    const archiveDir = path.join(__dirname, "..", "uploads", "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    retrySync(() => fs.renameSync(path.join(__dirname, "..", "uploads", crCode), path.join(archiveDir, crCode)));
  } catch (err) {
    console.error(`Failed to archive/wipe files for booking ${crCode}:`, err.message);
  }
}

// Tiny (24px-wide) heavily-blurred JPEG preview, inlined as a data URL, so a not-yet-downloaded
// image attachment can show a hint of its content behind the download prompt without the
// receiver's browser fetching the full file. Images only — no video frame extraction (no ffmpeg
// dependency in this project). Never throws: a failed/unsupported source just yields no preview.
// Takes the image's buffer directly (the R2 storage engine buffers images anyway, to feed
// both the R2 upload and this preview from the same in-memory bytes — no disk read needed).
async function generateBlurDataUrl(buffer, mimetype) {
  if (!/^image\//i.test(mimetype) || !buffer) return undefined;
  try {
    const buf = await sharp(buffer).resize(32, 32, { fit: "inside" }).blur(0.5).jpeg({ quality: 50 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

module.exports = { chatDiskFolder, deliverableDiskFolder, diskFolderFor, redirectToStoredFile, moveStoredFile, archiveAndWipeBookingFiles, generateBlurDataUrl };
