const stripe = require("./stripe");
const Notification = require("../models/Notification");
const { sendAcceptanceEmail, sendAdminInvoiceAlert } = require("./mailer");
const { endOfDay, minDueDate } = require("./dates");
const { MIN_DUE_DATE_LEAD_DAYS } = require("../config/limits");

// Shared Stripe invoice helpers — reused by both the superadmin /admin/booking/:id/* routes
// and the editor /associate/booking/:id/* routes, since editors can send/reissue invoices for
// their own assigned projects too. Each throws a user-facing Error on validation/Stripe failure;
// callers redirect back to their own booking-detail URL with ?error=<message>.
async function createDepositInvoice(booking, agreedPrice, dueDateStr) {
  // Sending the deposit invoice also flips status to "accepted", which is the same
  // moment the client's dashboard would show the pay link. Require the booking to have
  // already passed through "in-review" so the client had a window to upload files via
  // their dashboard before ever seeing a payment ask — otherwise accept+invoice could
  // fire straight from "pending" with nothing uploaded yet.
  if (!["in-review", "accepted", "in-progress"].includes(booking.status)) {
    throw new Error("Move status to In Review first so the client can upload files before the deposit invoice goes out.");
  }
  // No deposit ask until the client has actually put footage on the table — otherwise
  // we'd be invoicing against a project that's still just a form submission.
  if (!(booking.uploadedFiles || []).some(f => f.mimetype && /^video\//i.test(f.mimetype))) {
    throw new Error("The client hasn't uploaded a video yet — wait for at least one before sending the deposit invoice.");
  }
  if (!agreedPrice || agreedPrice <= 0) throw new Error("Enter a valid agreed price.");
  const depositDueDate = endOfDay(dueDateStr);
  if (!depositDueDate || depositDueDate < minDueDate()) {
    throw new Error(`Deposit due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`);
  }

  const existing = await stripe.customers.list({ email: booking.email, limit: 1 });
  const customer = existing.data.length
    ? existing.data[0]
    : await stripe.customers.create({ email: booking.email, name: booking.name, metadata: { crCode: booking.crCode } });

  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: "send_invoice",
    due_date: Math.floor(depositDueDate.getTime() / 1000),
    currency: "usd",
    metadata: { crCode: booking.crCode },
  });
  await stripe.invoiceItems.create({
    customer: customer.id,
    invoice: invoice.id,
    amount: Math.round(agreedPrice * 0.30 * 100),
    currency: "usd",
    description: `30% Deposit — Jarumiri Studios (${booking.crCode})`,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  booking.agreedPrice = agreedPrice;
  booking.stripeCustomerId = customer.id;
  booking.depositInvoiceId = invoice.id;
  booking.depositInvoiceUrl = finalized.hosted_invoice_url;
  booking.depositStatus = "pending";
  booking.status = "accepted";
  booking.depositDueDate = depositDueDate;
  await booking.save();

  sendAcceptanceEmail(booking);
  sendAdminInvoiceAlert(booking, "deposit", agreedPrice * 0.30, finalized.hosted_invoice_url);
  if (booking.clientId) {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "invoice_sent",
      message: `A deposit invoice ($${(agreedPrice * 0.30).toFixed(2)}) has been sent for project ${booking.crCode}. You can review it and pay anytime from your project page.`,
    });
  }
}

async function reissueDepositInvoice(booking, dueDateStr) {
  const depositDueDate = endOfDay(dueDateStr);
  if (!depositDueDate || depositDueDate < minDueDate()) {
    throw new Error(`Deposit due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`);
  }
  if (booking.depositDueDate && depositDueDate.getTime() === booking.depositDueDate.getTime()) return;

  if (booking.depositInvoiceId) await stripe.invoices.voidInvoice(booking.depositInvoiceId);

  const invoice = await stripe.invoices.create({
    customer: booking.stripeCustomerId,
    collection_method: "send_invoice",
    due_date: Math.floor(depositDueDate.getTime() / 1000),
    currency: "usd",
    metadata: { crCode: booking.crCode },
  });
  await stripe.invoiceItems.create({
    customer: booking.stripeCustomerId,
    invoice: invoice.id,
    amount: Math.round(booking.agreedPrice * 0.30 * 100),
    currency: "usd",
    description: `30% Deposit — Jarumiri Studios (${booking.crCode})`,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  booking.depositInvoiceId = invoice.id;
  booking.depositInvoiceUrl = finalized.hosted_invoice_url;
  booking.depositDueDate = depositDueDate;
  booking.depositReminderSent = false;
  await booking.save();

  if (booking.clientId) {
    const dueDateLabel = depositDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "due_date_updated",
      message: `The deposit due date for project ${booking.crCode} has been moved to ${dueDateLabel}. A fresh payment link has been sent.`,
    });
  }
}

async function createFinalInvoice(booking, dueDateStr) {
  const finalDueDate = endOfDay(dueDateStr);
  if (!finalDueDate || finalDueDate < minDueDate()) {
    throw new Error(`Final due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`);
  }

  const invoice = await stripe.invoices.create({
    customer: booking.stripeCustomerId,
    collection_method: "send_invoice",
    due_date: Math.floor(finalDueDate.getTime() / 1000),
    currency: "usd",
    metadata: { crCode: booking.crCode },
  });
  await stripe.invoiceItems.create({
    customer: booking.stripeCustomerId,
    invoice: invoice.id,
    amount: Math.round(booking.agreedPrice * 0.70 * 100),
    currency: "usd",
    description: `Final Payment — Jarumiri Studios (${booking.crCode})`,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  booking.finalInvoiceId = invoice.id;
  booking.finalInvoiceUrl = finalized.hosted_invoice_url;
  booking.finalPaymentStatus = "pending";
  booking.finalDueDate = finalDueDate;
  await booking.save();

  sendAdminInvoiceAlert(booking, "final", booking.agreedPrice * 0.70, finalized.hosted_invoice_url);
  if (booking.clientId) {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "invoice_sent",
      message: `A final invoice ($${(booking.agreedPrice * 0.70).toFixed(2)}) has been sent for project ${booking.crCode}. You can review it and pay anytime from your project page.`,
    });
  }
}

async function reissueFinalInvoice(booking, dueDateStr) {
  const finalDueDate = endOfDay(dueDateStr);
  if (!finalDueDate || finalDueDate < minDueDate()) {
    throw new Error(`Final due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`);
  }
  if (booking.finalDueDate && finalDueDate.getTime() === booking.finalDueDate.getTime()) return;

  if (booking.finalInvoiceId) await stripe.invoices.voidInvoice(booking.finalInvoiceId);

  const invoice = await stripe.invoices.create({
    customer: booking.stripeCustomerId,
    collection_method: "send_invoice",
    due_date: Math.floor(finalDueDate.getTime() / 1000),
    currency: "usd",
    metadata: { crCode: booking.crCode },
  });
  await stripe.invoiceItems.create({
    customer: booking.stripeCustomerId,
    invoice: invoice.id,
    amount: Math.round(booking.agreedPrice * 0.70 * 100),
    currency: "usd",
    description: `Final Payment — Jarumiri Studios (${booking.crCode})`,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  booking.finalInvoiceId = invoice.id;
  booking.finalInvoiceUrl = finalized.hosted_invoice_url;
  booking.finalDueDate = finalDueDate;
  booking.finalReminderSent = false;
  await booking.save();

  if (booking.clientId) {
    const dueDateLabel = finalDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "due_date_updated",
      message: `The final payment due date for project ${booking.crCode} has been moved to ${dueDateLabel}. A fresh payment link has been sent.`,
    });
  }
}

// Ad-hoc invoice for extra revision work — unlike deposit/final there's no cap, a project can
// get several of these over its life. Requires stripeCustomerId (set the first time a deposit
// invoice goes out), since a revision charge only makes sense once work is already underway.
async function createRevisionInvoice(booking, amount, dueDateStr) {
  if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
  const dueDate = endOfDay(dueDateStr);
  if (!dueDate || dueDate < minDueDate()) {
    throw new Error(`Due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`);
  }

  const invoice = await stripe.invoices.create({
    customer: booking.stripeCustomerId,
    collection_method: "send_invoice",
    due_date: Math.floor(dueDate.getTime() / 1000),
    currency: "usd",
    metadata: { crCode: booking.crCode },
  });
  await stripe.invoiceItems.create({
    customer: booking.stripeCustomerId,
    invoice: invoice.id,
    amount: Math.round(amount * 100),
    currency: "usd",
    description: `Revision fee — Jarumiri Studios (${booking.crCode})`,
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  booking.revisionInvoices.push({ invoiceId: invoice.id, invoiceUrl: finalized.hosted_invoice_url, amount, dueDate, status: "pending" });
  await booking.save();

  sendAdminInvoiceAlert(booking, "revision", amount, finalized.hosted_invoice_url);
  if (booking.clientId) {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "invoice_sent",
      message: `A revision invoice ($${amount.toFixed(2)}) has been sent for project ${booking.crCode}. You can review it and pay anytime from your project page.`,
    });
  }
}

module.exports = { createDepositInvoice, reissueDepositInvoice, createFinalInvoice, reissueFinalInvoice, createRevisionInvoice };
