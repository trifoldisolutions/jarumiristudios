const mongoose = require("mongoose");

// Records only failed logins, keyed by whatever identifies the guesser
// (normalized email for /login, visitor cookie for /admin/login — see routes/app.js and routes/admin.js).
// TTL index prunes rows well after the rolling window they're checked against
// stops caring about them, so this collection never needs a cleanup job.
const loginAttemptSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

loginAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 });

module.exports = mongoose.model("LoginAttempt", loginAttemptSchema);
