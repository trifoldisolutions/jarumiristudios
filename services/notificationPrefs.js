const User = require("../models/User");

async function bookingEmailUpdatesAllowed(booking) {
  if (booking.clientId) {
    const user = await User.findById(booking.clientId).select("notificationPreferences");
    return user?.notificationPreferences?.emailUpdates !== false;
  }
  return booking.emailConsent === true; // guest booking — only signal we have is its own consent flag
}

module.exports = { bookingEmailUpdatesAllowed };
