const mongoose = require("mongoose");
const fileMetadataFields = require("./shared/fileMetadata");

const applicationSchema = new mongoose.Schema(
  {
    appCode: { type: String, unique: true },
    visitorId: { type: String },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", default: null },
    roleTitle: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    file: { ...fileMetadataFields },
  },
  { timestamps: true }
);

// Backs the guest-quota check (enforceApplicationSubmissionQuota in middleware/quotas.js), which looks
// up a visitor's recent submissions on every application POST.
applicationSchema.index({ visitorId: 1, createdAt: -1 });

applicationSchema.pre("save", async function () {
  if (this.appCode) return;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  let code, exists;
  do {
    const r = rand();
    code = `${r.slice(0, 3)}-${r.slice(3, 6)}-${r.slice(6, 9)}`;
    exists = await mongoose.model("Application").exists({ appCode: code });
  } while (exists);
  this.appCode = code;
});

module.exports = mongoose.model("Application", applicationSchema);
