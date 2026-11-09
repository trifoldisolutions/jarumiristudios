const User = require("../models/User");
const Notification = require("../models/Notification");
const { sendSignupDiscountReminderEmail } = require("./mailer");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour, same cadence as invoiceExpiry
const REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days before expiry

async function checkUpcomingDiscountReminders() {
  const soon = new Date(Date.now() + REMINDER_LEAD_MS);
  const upcoming = await User.find({
    discountUsed: false,
    discountExpiresAt: { $exists: true, $gt: new Date(), $lte: soon },
    discountReminderSent: { $ne: true },
  });

  for (const stale of upcoming) {
    const user = await User.findOneAndUpdate(
      { _id: stale._id, discountReminderSent: { $ne: true } },
      { discountReminderSent: true },
      { new: true }
    );
    if (!user) continue; // already reminded between the query and here

    if (user.notificationPreferences?.emailUpdates !== false) sendSignupDiscountReminderEmail(user);

    await Notification.create({
      userId: user._id,
      type: "due_date_reminder",
      message: `Your ${user.discountPercent}% welcome discount expires on ${user.discountExpiresAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })} — book your next project to use it.`,
    });
  }
}

function startDiscountExpiryJob() {
  const run = () => checkUpcomingDiscountReminders().catch((err) => console.error("Discount reminder check error:", err.message));
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}

module.exports = { startDiscountExpiryJob, checkUpcomingDiscountReminders };
