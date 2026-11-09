const mongoose = require("mongoose");
const fileMetadataFields = require("./shared/fileMetadata");

const bookingRequestSchema = new mongoose.Schema(
  {
    crCode: { type: String, unique: true },
    visitorId: { type: String },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    location: { type: String, required: true, trim: true },
    clientType: {
      type: String,
      required: true,
      enum: ["Independent Creator", "Agency", "Studio", "Brand / Business", "Other"],
    },
    serviceType: {
      type: [String],
      enum: ["Video Editing", "Color Grading", "Sound Design", "Motion Graphics"],
      validate: { validator: (v) => v.length > 0, message: "At least one service is required." },
    },
    pricingTier: {
      type: String,
      required: true,
      // "Clip" kept for historical bookings only — no longer offered, replaced by "Free".
      enum: ["Clip", "Free", "Scene", "Feature", "Custom"],
    },
    addOns: [{ type: String }],
    budget: { type: String, trim: true },
    projectBrief: { type: String, required: true, trim: true, maxlength: 2000 },
    mediaLinks: [{ type: String, trim: true }],
    platforms: {
      type: [
        {
          platform: { type: String, enum: ["Instagram", "Twitter", "TikTok", "OnlyFans", "Fansly", "Fanview", "MannyVids", "Pornhub", "Other"], required: true },
          handle: { type: String, trim: true, required: true },
        },
      ],
      validate: { validator: (v) => v.length >= 1 && v.length <= 3, message: "Add between 1 and 3 external links." },
    },
    tosAgreedAt: { type: Date },
    emailConsent: { type: Boolean, default: false },
    uploadedFiles: [{ ...fileMetadataFields }],
    deliverableFiles: [{ ...fileMetadataFields, uploadedAt: { type: Date, default: Date.now } }],
    status: {
      type: String,
      enum: ["pending", "in-review", "accepted", "declined", "in-progress", "completed", "paused"],
      default: "pending",
    },
    agreedPrice: { type: Number },
    stripeCustomerId: { type: String },
    depositInvoiceId: { type: String },
    finalInvoiceId: { type: String },
    depositInvoiceUrl: { type: String },
    finalInvoiceUrl: { type: String },
    depositStatus: { type: String, enum: ["none", "pending", "paid"], default: "none" },
    finalPaymentStatus: { type: String, enum: ["none", "pending", "paid"], default: "none" },
    depositDueDate: { type: Date },
    finalDueDate: { type: Date },
    depositReminderSent: { type: Boolean, default: false },
    finalReminderSent: { type: Boolean, default: false },
    deliveryDate: { type: Date },
    couponCodes: [
      {
        code: { type: String },
        discountType: { type: String, enum: ["percent", "fixed"] },
        discountValue: { type: Number },
        amount: { type: Number },
      },
    ],
    discountAmount: { type: Number, default: 0 },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Associate", default: null },
    revisions: [
      {
        message: { type: String, required: true, trim: true },
        createdAt: { type: Date, default: Date.now },
        status: { type: String, enum: ["pending", "reviewed"], default: "pending" },
      },
    ],
    // Ad-hoc invoices for extra revision work, sent one at a time (unlike deposit/final there's
    // no cap — a project can rack up several over its life), each tracked independently.
    revisionInvoices: [
      {
        invoiceId: { type: String },
        invoiceUrl: { type: String },
        amount: { type: Number },
        dueDate: { type: Date },
        status: { type: String, enum: ["pending", "paid", "void"], default: "pending" },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    // Free-tier obligation trade for the discounted edit — either one satisfies it.
    testimonial: {
      text: { type: String, trim: true, maxlength: 2000 },
      submittedAt: { type: Date },
    },
    galleryRightsGranted: { type: Boolean, default: false },
    galleryRightsGrantedAt: { type: Date },
    archived: { type: Boolean, default: false },
    filesDeleted: { type: Boolean, default: false },
    // Admin-only mute — client keeps read access to the thread but can't send. Independent of
    // chatUnlocked (which gates the thread on project phase, not moderation).
    chatBlocked: { type: Boolean, default: false },
    adminNotes: [
      {
        text: { type: String, required: true, trim: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

// Backs the guest-quota check (enforceGuestSubmissionQuota in middleware/quotas.js), which looks up
// a visitor's recent submissions on every /hire POST.
bookingRequestSchema.index({ visitorId: 1, createdAt: -1 });

// Single source of truth for "can the client download final deliverables yet" —
// keep every gate (routes + views) checking this instead of a literal status string,
// since the underlying rule (currently just status) is likely to grow conditions later.
bookingRequestSchema.virtual("deliverablesUnlocked").get(function () {
  return this.status === "completed";
});

// Chat opens once a project has been accepted and stays open through the rest of its
// lifecycle (in-progress/completed/paused) — pending/in-review/declined stay locked.
bookingRequestSchema.virtual("chatUnlocked").get(function () {
  return ["accepted", "in-progress", "completed", "paused"].includes(this.status);
});

bookingRequestSchema.pre("save", async function () {
  if (this.crCode) return;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  let code, exists;
  do {
    const r = rand();
    code = `${r.slice(0,3)}-${r.slice(3,6)}-${r.slice(6,9)}`;
    exists = await mongoose.model("BookingRequest").exists({ crCode: code });
  } while (exists);
  this.crCode = code;
});

module.exports = mongoose.model("BookingRequest", bookingRequestSchema);
