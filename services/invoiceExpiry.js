const BookingRequest = require("../models/BookingRequest");
const Notification = require("../models/Notification");
const { archiveBookingFolder } = require("./uploadUtils");
const { bookingEmailUpdatesAllowed } = require("./notificationPrefs");
const {
  sendDepositExpiredEmail,
  sendAdminDepositExpiredAlert,
  sendFinalExpiredEmail,
  sendAdminFinalExpiredAlert,
  sendProjectArchivedEmail,
  sendAdminProjectArchivedAlert,
  sendDepositReminderEmail,
  sendFinalReminderEmail,
} = require("./mailer");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const FINAL_EXPIRY_ARCHIVE_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

async function checkExpiredDeposits(stripe) {
  const expired = await BookingRequest.find({
    status: "accepted",
    depositStatus: "pending",
    archived: { $ne: true },
    depositDueDate: { $exists: true, $lt: new Date() },
  });

  for (const stale of expired) {
    const booking = await BookingRequest.findOneAndUpdate(
      { _id: stale._id, status: "accepted", depositStatus: "pending" },
      { status: "declined", archived: true },
      { new: true }
    );
    if (!booking) continue; // paid or already resolved between the query and here

    archiveBookingFolder(booking.crCode);

    if (booking.depositInvoiceId) {
      try {
        await stripe.invoices.voidInvoice(booking.depositInvoiceId);
      } catch (err) {
        console.error("Deposit invoice void error:", err.message);
      }
    }

    if (await bookingEmailUpdatesAllowed(booking)) sendDepositExpiredEmail(booking);
    sendAdminDepositExpiredAlert(booking);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "project_dismissed",
        message: `Project ${booking.crCode} has been put on hold — the deposit due date passed without payment. Reach out whenever you're ready to pick it back up.`,
      });
    }
  }
}

async function checkExpiredFinalInvoices(stripe) {
  const expired = await BookingRequest.find({
    finalPaymentStatus: "pending",
    archived: { $ne: true },
    finalDueDate: { $exists: true, $lt: new Date() },
  });

  for (const stale of expired) {
    // finalDueDate is deliberately left as-is (not nulled) — nothing else keys off its presence
    // without also checking finalPaymentStatus, and checkStaleAfterFinalExpiry below needs it
    // as the anchor for the 3-day archive grace period. A fresh final invoice (createFinalInvoice
    // in services/invoices.js) overwrites it with a new date and flips finalPaymentStatus back to "pending"
    // anyway, so it never lingers stale once the client's actually re-invoiced.
    const booking = await BookingRequest.findOneAndUpdate(
      { _id: stale._id, finalPaymentStatus: "pending" },
      { finalPaymentStatus: "none", finalInvoiceId: null, finalInvoiceUrl: null, finalReminderSent: false },
      { new: true }
    );
    if (!booking) continue; // paid or already resolved between the query and here

    if (stale.finalInvoiceId) {
      try {
        await stripe.invoices.voidInvoice(stale.finalInvoiceId);
      } catch (err) {
        console.error("Final invoice void error:", err.message);
      }
    }

    if (await bookingEmailUpdatesAllowed(booking)) sendFinalExpiredEmail(booking);
    sendAdminFinalExpiredAlert(booking);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "invoice_expired",
        message: `The final payment link for project ${booking.crCode} has expired. Reach out whenever you're ready and we'll send a fresh one.`,
      });
    }
  }
}

// A project whose final invoice expired (checkExpiredFinalInvoices above) and never got a
// fresh one sent within 3 days gets archived — same overdue-storage rationale as the deposit
// case, just with a grace window since the client may still be arranging payment. Keyed on
// finalDueDate (left un-cleared above) rather than a separate timestamp: a fresh invoice
// overwrites finalDueDate and flips finalPaymentStatus back to "pending", which drops the
// booking out of this query on its own.
async function checkStaleAfterFinalExpiry() {
  const threshold = new Date(Date.now() - FINAL_EXPIRY_ARCHIVE_GRACE_MS);
  const stale = await BookingRequest.find({
    finalPaymentStatus: "none",
    archived: { $ne: true },
    finalDueDate: { $exists: true, $lt: threshold },
  });

  for (const s of stale) {
    const booking = await BookingRequest.findOneAndUpdate(
      { _id: s._id, finalPaymentStatus: "none", archived: { $ne: true } },
      { archived: true },
      { new: true }
    );
    if (!booking) continue; // re-invoiced or already archived between the query and here

    archiveBookingFolder(booking.crCode);

    if (await bookingEmailUpdatesAllowed(booking)) sendProjectArchivedEmail(booking);
    sendAdminProjectArchivedAlert(booking);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "project_dismissed",
        message: `Project ${booking.crCode} has been archived — the final payment window passed without a new invoice. Reach out whenever you're ready to pick it back up.`,
      });
    }
  }
}

async function checkUpcomingDepositReminders() {
  const soon = new Date(Date.now() + REMINDER_WINDOW_MS);
  const upcoming = await BookingRequest.find({
    status: "accepted",
    depositStatus: "pending",
    archived: { $ne: true },
    depositDueDate: { $exists: true, $gt: new Date(), $lte: soon },
    depositReminderSent: { $ne: true },
  });

  for (const stale of upcoming) {
    const booking = await BookingRequest.findOneAndUpdate(
      { _id: stale._id, depositReminderSent: { $ne: true } },
      { depositReminderSent: true },
      { new: true }
    );
    if (!booking) continue; // already reminded between the query and here

    if (await bookingEmailUpdatesAllowed(booking)) sendDepositReminderEmail(booking);

    if (booking.clientId) {
      const dueDateStr = booking.depositDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "due_date_reminder",
        message: `Reminder: the deposit for project ${booking.crCode} is due by ${dueDateStr}.`,
      });
    }
  }
}

async function checkUpcomingFinalReminders() {
  const soon = new Date(Date.now() + REMINDER_WINDOW_MS);
  const upcoming = await BookingRequest.find({
    finalPaymentStatus: "pending",
    archived: { $ne: true },
    finalDueDate: { $exists: true, $gt: new Date(), $lte: soon },
    finalReminderSent: { $ne: true },
  });

  for (const stale of upcoming) {
    const booking = await BookingRequest.findOneAndUpdate(
      { _id: stale._id, finalReminderSent: { $ne: true } },
      { finalReminderSent: true },
      { new: true }
    );
    if (!booking) continue; // already reminded between the query and here

    if (await bookingEmailUpdatesAllowed(booking)) sendFinalReminderEmail(booking);

    if (booking.clientId) {
      const dueDateStr = booking.finalDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "due_date_reminder",
        message: `Reminder: the final payment for project ${booking.crCode} is due by ${dueDateStr}.`,
      });
    }
  }
}

function startInvoiceExpiryJob(stripe) {
  const runChecks = () => {
    checkExpiredDeposits(stripe).catch((err) => console.error("Deposit expiry check error:", err.message));
    checkExpiredFinalInvoices(stripe).catch((err) => console.error("Final invoice expiry check error:", err.message));
    checkStaleAfterFinalExpiry().catch((err) => console.error("Stale final-expiry archive check error:", err.message));
    checkUpcomingDepositReminders().catch((err) => console.error("Deposit reminder check error:", err.message));
    checkUpcomingFinalReminders().catch((err) => console.error("Final reminder check error:", err.message));
  };
  runChecks();
  setInterval(runChecks, CHECK_INTERVAL_MS);
}

module.exports = {
  startInvoiceExpiryJob,
  checkExpiredDeposits,
  checkExpiredFinalInvoices,
  checkStaleAfterFinalExpiry,
  checkUpcomingDepositReminders,
  checkUpcomingFinalReminders,
};
