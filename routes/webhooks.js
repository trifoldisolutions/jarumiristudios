const express = require("express");
const BookingRequest = require("../models/BookingRequest");
const Notification = require("../models/Notification");
const AdminNotification = require("../models/AdminNotification");
const AssociateNotification = require("../models/AssociateNotification");
const stripe = require("../services/stripe");
const { sendAdminPaymentAlert, sendAdminUnexpectedPaymentAlert } = require("../services/mailer");

const router = express.Router();

// Stripe webhook — must be before express.json() to receive raw body for signature verification
router.post("/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.sendStatus(400);
  }

  try {
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const crCode = invoice.metadata?.crCode;
      if (crCode) {
        const booking = await BookingRequest.findOne({ crCode });
        if (booking) {
          const isInactive = booking.archived || booking.status === "declined" || booking.status === "paused";
          let notifMsg = null;
          let paymentType = null;
          if (invoice.id === booking.depositInvoiceId) {
            booking.depositStatus = "paid";
            paymentType = "deposit";
            notifMsg = isInactive
              ? `We received your deposit payment for project ${booking.crCode}. We'll follow up shortly to confirm next steps.`
              : `Deposit payment received for project ${booking.crCode}. We'll confirm and begin work shortly.`;
          } else if (invoice.id === booking.finalInvoiceId) {
            booking.finalPaymentStatus = "paid";
            paymentType = "final";
            if (isInactive) {
              notifMsg = `We received your final payment for project ${booking.crCode}. We'll follow up shortly to confirm next steps.`;
            } else {
              booking.status = "completed";
              notifMsg = `Final payment confirmed for project ${booking.crCode}. Your project is complete!`;
              if (booking.deliverableFiles?.length > 0) {
                notifMsg += " Your final files are ready to download.";
              }
            }
          } else {
            const revisionInvoice = booking.revisionInvoices.find((ri) => ri.invoiceId === invoice.id);
            if (revisionInvoice) {
              revisionInvoice.status = "paid";
              paymentType = "revision";
              notifMsg = `Payment received for the revision invoice on project ${booking.crCode}. Thanks!`;
            }
          }
          await booking.save();
          if (paymentType) {
            const paidAmount = (invoice.amount_paid / 100);
            if (isInactive) {
              sendAdminUnexpectedPaymentAlert(booking, paymentType, paidAmount);
            } else {
              sendAdminPaymentAlert(booking, paymentType, paidAmount);
            }
          }
          if (notifMsg && booking.clientId) {
            await Notification.create({
              userId: booking.clientId,
              bookingId: booking._id,
              crCode: booking.crCode,
              type: "payment_confirmed",
              message: notifMsg,
            });
          }
          if (paymentType === "deposit") {
            const depositAmount = (invoice.amount_paid / 100).toFixed(2);
            await AdminNotification.create({
              bookingId: booking._id,
              crCode: booking.crCode,
              type: "payment",
              message: isInactive
                ? `Deposit of $${depositAmount} wired for project ${booking.crCode}, which is currently ${booking.archived ? "archived" : booking.status}. Review manually.`
                : `Deposit of $${depositAmount} wired for project ${booking.crCode}. Confirm receipt and move it to in-progress.`,
            });
          }
          if ((paymentType === "deposit" || paymentType === "final") && booking.assignedTo) {
            const paidAmount = (invoice.amount_paid / 100).toFixed(2);
            await AssociateNotification.create({
              associateId: booking.assignedTo,
              bookingId: booking._id,
              crCode: booking.crCode,
              type: "payment",
              message: paymentType === "deposit"
                ? `Deposit of $${paidAmount} received for project ${booking.crCode}.`
                : `Final payment of $${paidAmount} received for project ${booking.crCode}.`,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    return res.sendStatus(500);
  }

  res.sendStatus(200);
});

router.routes = [
  { method: "POST", path: "/stripe", label: "Stripe payment events" },
];

module.exports = router;
