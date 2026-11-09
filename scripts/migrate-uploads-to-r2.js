// One-time migration: uploads everything currently on the local `uploads/` tree (both the
// active tree and the `_archive` mirror) to R2, then backfills each Mongo file-metadata
// subdocument's storageKey/folder/backend fields. Safe to re-run — skips anything already
// recorded as verified in the manifest, and never deletes local files.
//
// Must run on Railway, where the persistent volume actually lives:
//   railway run node scripts/migrate-uploads-to-r2.js upload
//   railway run node scripts/migrate-uploads-to-r2.js backfill   (only after `upload` is clean)
//   railway run node scripts/migrate-uploads-to-r2.js verify     (read-only reconciliation)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { streamUpload, headObject } = require("../services/r2");
const BookingRequest = require("../models/BookingRequest");
const Message = require("../models/Message");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");
const MANIFEST_PATH = path.join(__dirname, "migration-manifest.json");

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}
function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walk(full));
    else results.push(full);
  }
  return results;
}

// Parses `uploads/<crCode>/files/<folder>/<storedName>` or
// `uploads/_archive/<crCode>/files/<folder>/<storedName>` — anything else (e.g. booking.txt)
// isn't a media file and is skipped.
function parseUploadPath(fullPath) {
  const rel = path.relative(UPLOADS_ROOT, fullPath).split(path.sep);
  if (rel[0] === "_archive") {
    if (rel.length !== 5 || rel[2] !== "files") return null;
    return { crCode: rel[1], folder: rel[3], storedName: rel[4] };
  }
  if (rel.length !== 4 || rel[1] !== "files") return null;
  return { crCode: rel[0], folder: rel[2], storedName: rel[3] };
}

// storedName -> mimetype, built from every Mongo file-metadata record, so uploads carry the
// correct Content-Type instead of guessing from the file extension.
async function buildMimetypeMap() {
  const map = new Map();
  const bookings = await BookingRequest.find({}, "uploadedFiles deliverableFiles").lean();
  for (const b of bookings) {
    for (const f of [...(b.uploadedFiles || []), ...(b.deliverableFiles || [])]) {
      if (f.storedName) map.set(f.storedName, f.mimetype);
    }
  }
  const messages = await Message.find({}, "attachment attachments").lean();
  for (const m of messages) {
    const atts = [...(m.attachments || []), ...(m.attachment ? [m.attachment] : [])];
    for (const a of atts) {
      if (a.storedName) map.set(a.storedName, a.mimetype);
    }
  }
  return map;
}

async function phaseUpload() {
  await mongoose.connect(process.env.MONGO_URI);
  const mimeMap = await buildMimetypeMap();
  const manifest = loadManifest();
  const files = walk(UPLOADS_ROOT);
  console.log(`Found ${files.length} local paths under ${UPLOADS_ROOT}`);

  let uploaded = 0, skipped = 0, failed = 0;
  for (const fullPath of files) {
    const parsed = parseUploadPath(fullPath);
    if (!parsed) { skipped++; continue; }
    const { crCode, folder, storedName } = parsed;
    if (manifest[storedName]?.status === "verified") { skipped++; continue; }

    const key = `${crCode}/${storedName}`;
    const mimetype = mimeMap.get(storedName) || "application/octet-stream";
    try {
      const stat = fs.statSync(fullPath);
      await streamUpload(key, fs.createReadStream(fullPath), mimetype);
      const head = await headObject(key);
      if (Number(head.ContentLength) !== stat.size) {
        throw new Error(`size mismatch: local ${stat.size} vs R2 ${head.ContentLength}`);
      }
      manifest[storedName] = { r2Key: key, crCode, folder, status: "verified" };
      uploaded++;
    } catch (err) {
      manifest[storedName] = { r2Key: key, crCode, folder, status: "failed", error: err.message };
      failed++;
      console.error(`FAILED ${fullPath}:`, err.message);
    }
    saveManifest(manifest); // persist after every file — a crash/interrupt loses at most one file's progress
  }
  console.log(`Uploaded ${uploaded}, skipped ${skipped} (already verified or not a media file), failed ${failed}`);
  await mongoose.disconnect();
}

async function phaseBackfill() {
  await mongoose.connect(process.env.MONGO_URI);
  const manifest = loadManifest();
  let updated = 0;

  const bookings = await BookingRequest.find({});
  for (const booking of bookings) {
    let changed = false;
    for (const arr of [booking.uploadedFiles, booking.deliverableFiles]) {
      for (const f of arr) {
        const entry = manifest[f.storedName];
        if (entry?.status === "verified" && f.backend !== "r2") {
          f.storageKey = entry.r2Key;
          f.folder = f.folder || entry.folder;
          f.backend = "r2";
          changed = true;
          updated++;
        }
      }
    }
    if (changed) await booking.save();
  }

  const messages = await Message.find({});
  for (const message of messages) {
    let changed = false;
    const arrays = [message.attachments, ...(message.attachment ? [[message.attachment]] : [])];
    for (const arr of arrays) {
      for (const a of arr) {
        const entry = manifest[a.storedName];
        if (entry?.status === "verified" && a.backend !== "r2") {
          a.storageKey = entry.r2Key;
          a.folder = a.folder || entry.folder;
          a.backend = "r2";
          changed = true;
          updated++;
        }
      }
    }
    if (changed) await message.save();
  }

  console.log(`Backfilled ${updated} file-metadata records with backend:"r2".`);
  await mongoose.disconnect();
}

async function phaseVerify() {
  await mongoose.connect(process.env.MONGO_URI);
  const manifest = loadManifest();
  const localFiles = walk(UPLOADS_ROOT).filter((f) => parseUploadPath(f));
  const verifiedCount = Object.values(manifest).filter((e) => e.status === "verified").length;
  const failedEntries = Object.entries(manifest).filter(([, e]) => e.status === "failed");

  console.log(`Local media files found: ${localFiles.length}`);
  console.log(`Manifest entries verified: ${verifiedCount}`);
  console.log(`Manifest entries failed: ${failedEntries.length}`);
  failedEntries.forEach(([name, e]) => console.log(`  FAILED ${name}: ${e.error}`));

  const docsWithR2 = await BookingRequest.countDocuments({
    $or: [{ "uploadedFiles.backend": "r2" }, { "deliverableFiles.backend": "r2" }],
  });
  console.log(`BookingRequest docs with at least one backend:"r2" file: ${docsWithR2}`);
  await mongoose.disconnect();
}

const mode = process.argv[2];
const run = { upload: phaseUpload, backfill: phaseBackfill, verify: phaseVerify }[mode];
if (!run) {
  console.error("Usage: node scripts/migrate-uploads-to-r2.js <upload|backfill|verify>");
  process.exit(1);
}
run().catch((err) => { console.error(err); process.exit(1); });
