const User = require("../models/User");
const Notification = require("../models/Notification");

const STATUS_LABELS = {
  pending: "Pending",
  "in-review": "In Review",
  accepted: "Accepted",
  declined: "Declined",
  "in-progress": "In Progress",
  completed: "Completed",
  paused: "Paused",
};

const BOOKING_STATUSES = Object.keys(STATUS_LABELS);

// Core happy-path progression. "paused" and "declined" are handled as special
// cases below rather than living in this line — see isStatusChangeAllowed.
const STATUS_CORE_ORDER = ["pending", "in-review", "accepted", "in-progress", "completed"];

const STATUS_GATE_HINTS = {
  "in-review": "Requires reaching Pending first.",
  accepted: "Requires reaching In Review first.",
  "in-progress": "Requires reaching Accepted first.",
  completed: "Requires reaching In Progress first.",
  paused: "Only available while In Progress.",
  declined: "Not available once Completed.",
  pending: "",
};
const STATUS_GATE_TERMINAL_HINT = "This booking is finalized — status can no longer be changed.";

// Can a booking currently at `currentStatus` move to `targetStatus`?
// Forward moves through the core order require having reached the prior stage;
// backward moves are always allowed as a manual correction, unless the booking
// is in a terminal state (completed/declined), which locks out all changes.
function isStatusChangeAllowed(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) return true;
  if (currentStatus === "completed" || currentStatus === "declined") return false;

  if (targetStatus === "declined") return true;
  if (targetStatus === "paused") return currentStatus === "in-progress" || currentStatus === "paused";

  const coreIndex = (s) => STATUS_CORE_ORDER.indexOf(s === "paused" ? "in-progress" : s);
  const curIdx = coreIndex(currentStatus);
  const tgtIdx = STATUS_CORE_ORDER.indexOf(targetStatus);
  if (curIdx === -1 || tgtIdx === -1) return false;

  return tgtIdx <= curIdx + 1;
}

function getStatusGate(currentStatus) {
  const gate = {};
  for (const s of BOOKING_STATUSES) gate[s] = isStatusChangeAllowed(currentStatus, s);
  return gate;
}

const PIPELINE_STATUS_ORDER = ["pending", "in-review", "accepted", "in-progress", "completed", "paused", "declined"];

async function notifyStatusChange(bookings, newStatus) {
  const label = STATUS_LABELS[newStatus] || newStatus;
  const notifications = [];
  const freeTierObligations = [];
  for (const b of bookings) {
    if (newStatus === "completed" && b.pricingTier === "Free" && b.clientId) {
      freeTierObligations.push(
        User.updateOne({ _id: b.clientId }, { pendingTestimonialObligation: true, pendingTestimonialBookingId: b._id })
      );
    }
    if (!b.clientId) continue;
    notifications.push({
      userId: b.clientId,
      bookingId: b._id,
      crCode: b.crCode,
      type: newStatus === "declined" ? "project_dismissed" : "status_change",
      message: newStatus === "declined"
        ? `Project ${b.crCode} has been declined.`
        : `Project ${b.crCode} has moved to ${label}.`,
    });
    if (newStatus === "completed" && b.deliverableFiles?.length > 0) {
      notifications.push({
        userId: b.clientId,
        bookingId: b._id,
        crCode: b.crCode,
        type: "deliverable_ready",
        message: `Your final files are ready to download for project ${b.crCode}.`,
      });
    }
  }
  if (notifications.length) await Notification.insertMany(notifications);
  if (freeTierObligations.length) await Promise.all(freeTierObligations);
}

module.exports = { STATUS_LABELS, BOOKING_STATUSES, STATUS_GATE_HINTS, STATUS_GATE_TERMINAL_HINT, isStatusChangeAllowed, getStatusGate, PIPELINE_STATUS_ORDER, notifyStatusChange };
