// One-time migration: relocates every R2-backed file from the old flat key (`<crCode>/<storedName>`)
// to the new nested scheme (`<crCode>/{raws,finals,chats/clients,chats/associate}/<storedName>`),
// then updates each Mongo file-metadata subdocument's storageKey to match. Local-backend files are
// untouched (not in scope — see the folder-structure refactor this follows).
//
// Dry-run by default — prints the full migration plan without touching R2 or the database. Pass
// --execute to actually perform it. Safe to re-run: any key already under the new scheme is
// skipped, and each unique object is only copied once even if multiple documents reference it
// (e.g. a chat attachment promoted to a project file via "save to project" shares one object
// between its Message.attachments entry and its BookingRequest.uploadedFiles entry).
//
// Must run wherever the target MongoDB is actually reachable — for production data that's
// Railway, not this machine's local dev DB:
//   railway run node scripts/reorganize-r2-folders.js            (dry run)
//   railway run node scripts/reorganize-r2-folders.js --execute
// Optionally scope to one booking while testing: --crCode=ABC-123-XYZ
require("dotenv").config();
const mongoose = require("mongoose");
const { copyObject, deleteObject, headObject } = require("../services/r2");
const BookingRequest = require("../models/BookingRequest");
const Message = require("../models/Message");

const EXECUTE = process.argv.includes("--execute");
const crCodeArg = process.argv.find((a) => a.startsWith("--crCode="));
const ONLY_CR_CODE = crCodeArg ? crCodeArg.split("=")[1] : null;

function isNewScheme(crCode, key) {
  return (
    key.startsWith(`${crCode}/raws/`) ||
    key.startsWith(`${crCode}/finals/`) ||
    key.startsWith(`${crCode}/chats/clients/`) ||
    key.startsWith(`${crCode}/chats/associate/`)
  );
}

function chatFolder(senderRole) {
  return senderRole === "client" ? "chats/clients" : "chats/associate";
}

// plan: Map<oldKey, { newKey, refs: [{ save(newKey) }] }>
function addToPlan(plan, crCode, oldKey, folder, storedName, senderRole, ref) {
  if (!oldKey || isNewScheme(crCode, oldKey)) return;
  const targetFolder =
    folder === "deliverables" ? "finals" : !folder || folder === "chat" ? chatFolder(senderRole) : "raws";
  const newKey = `${crCode}/${targetFolder}/${storedName}`;
  const existing = plan.get(oldKey);
  if (existing) {
    if (existing.newKey !== newKey) {
      console.warn(`CONFLICT: ${oldKey} maps to both ${existing.newKey} and ${newKey} — skipping this key entirely.`);
      existing.conflict = true;
    }
    existing.refs.push(ref);
    return;
  }
  plan.set(oldKey, { newKey, refs: [ref] });
}

async function buildPlan() {
  const plan = new Map();
  const bookingFilter = ONLY_CR_CODE ? { crCode: ONLY_CR_CODE } : {};

  const bookings = await BookingRequest.find(bookingFilter).select("crCode uploadedFiles deliverableFiles");
  for (const booking of bookings) {
    for (const entry of booking.uploadedFiles) {
      if (entry.backend !== "r2" || !entry.storageKey) continue;
      addToPlan(plan, booking.crCode, entry.storageKey, "raws", entry.storedName, null, {
        describe: () => `BookingRequest ${booking.crCode} uploadedFiles ${entry._id}`,
        save: async (newKey) => {
          entry.storageKey = newKey;
          entry.folder = "raws";
          await booking.save();
        },
      });
    }
    for (const entry of booking.deliverableFiles) {
      if (entry.backend !== "r2" || !entry.storageKey) continue;
      addToPlan(plan, booking.crCode, entry.storageKey, "deliverables", entry.storedName, null, {
        describe: () => `BookingRequest ${booking.crCode} deliverableFiles ${entry._id}`,
        save: async (newKey) => {
          entry.storageKey = newKey;
          await booking.save();
        },
      });
    }
  }

  const messageFilter = ONLY_CR_CODE ? { crCode: ONLY_CR_CODE } : {};
  const messages = await Message.find(messageFilter).select("crCode senderRole attachment attachments");
  for (const message of messages) {
    const entries = [];
    if (message.attachment && message.attachment.storedName) entries.push(message.attachment);
    entries.push(...message.attachments);
    for (const entry of entries) {
      if (entry.backend !== "r2" || !entry.storageKey) continue;
      addToPlan(plan, message.crCode, entry.storageKey, entry.folder, entry.storedName, message.senderRole, {
        describe: () => `Message ${message._id} attachment ${entry._id}`,
        save: async (newKey) => {
          entry.storageKey = newKey;
          await message.save();
        },
      });
    }
  }

  return plan;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${process.env.MONGO_URI}`);
  if (ONLY_CR_CODE) console.log(`Scoped to crCode=${ONLY_CR_CODE}`);

  const plan = await buildPlan();
  const toMigrate = [...plan.entries()].filter(([, v]) => !v.conflict);
  const conflicts = [...plan.entries()].filter(([, v]) => v.conflict);

  console.log(`\nPlan: ${toMigrate.length} object(s) to migrate, ${conflicts.length} conflict(s) skipped.`);
  for (const [oldKey, { newKey, refs }] of toMigrate) {
    console.log(`  ${oldKey}\n    -> ${newKey}  (${refs.length} reference${refs.length > 1 ? "s" : ""}: ${refs.map((r) => r.describe()).join(", ")})`);
  }

  if (!EXECUTE) {
    console.log("\nDry run only — pass --execute to perform this migration.");
    await mongoose.disconnect();
    return;
  }

  let migrated = 0;
  let failed = 0;
  let missing = 0;
  for (const [oldKey, { newKey, refs }] of toMigrate) {
    try {
      await headObject(oldKey);
    } catch {
      // Source object already gone — most likely a client hard-delete wiped it after this plan
      // was built. The DB's dangling storageKey is expected in that case (filesDeleted gates the
      // UI's read path instead), so there's nothing to migrate here; leave the reference as-is.
      missing++;
      console.warn(`SKIP ${oldKey}: source object no longer exists in R2, leaving DB reference as-is.`);
      continue;
    }
    try {
      await copyObject(oldKey, newKey);
      await headObject(newKey); // verify the copy landed before touching anything else
      await deleteObject(oldKey);
      for (const ref of refs) await ref.save(newKey);
      migrated++;
      console.log(`OK   ${oldKey} -> ${newKey}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${oldKey}: ${err.message}`);
    }
  }

  console.log(`\nDone. Migrated ${migrated}, failed ${failed}, missing ${missing}, conflicts skipped ${conflicts.length}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
