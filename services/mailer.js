const { Resend } = require("resend");

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const PAYMENT_TYPE_LABELS = { deposit: "Deposit (30%)", final: "Final Payment (70%)", revision: "Revision Fee" };

const COLORS = {
  bg: "#f4f4f5",
  card: "#ffffff",
  header: "#0b0b0d",
  text: "#18181b",
  muted: "#6b7280",
  amber: "#fbbf24",
  amberDark: "#b45309",
  amberChipBg: "#fef3c7",
  amberChipText: "#92400e",
  border: "#e5e7eb",
};

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

function sendMail({ to, subject, html }) {
  return getResend().emails.send({
    from: process.env.MAIL_FROM,
    to,
    subject,
    html,
  }).then(({ error }) => {
    if (error) console.error("Mail send error:", error);
  }).catch((err) => console.error("Mail send error:", err));
}

// ---- Shared email building blocks -----------------------------------------

function layout({ preheader = "", bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
</head>
<body style="margin:0; padding:0; background-color:${COLORS.bg}; font-family:Helvetica,Arial,sans-serif;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.bg}; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:${COLORS.card}; border-radius:12px; overflow:hidden; border:1px solid ${COLORS.border};">
          <tr>
            <td style="background-color:${COLORS.header}; padding:26px 32px;">
              <span style="font-family:Georgia,'Times New Roman',serif; font-size:20px; font-weight:bold; letter-spacing:0.2px; color:#ffffff;">Jarumiri Studios<span style="color:${COLORS.amber};">.</span></span>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px; color:${COLORS.text}; font-size:15px; line-height:1.65;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px; border-top:1px solid ${COLORS.border}; color:${COLORS.muted}; font-size:12px; text-align:center;">
              Jarumiri Studios &middot; Video Editing &amp; Photo Retouching<br />
              <a href="https://jarumiristudios.com" style="color:${COLORS.muted}; text-decoration:underline;">jarumiristudios.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function button(text, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="border-radius:999px; background-color:${COLORS.amber};">
    <a href="${url}" style="display:inline-block; padding:13px 28px; font-size:14px; font-weight:bold; color:#000000; text-decoration:none; border-radius:999px;">${text}</a>
  </td></tr></table>`;
}

function codeChip(code) {
  return `<span style="display:inline-block; background-color:${COLORS.amberChipBg}; color:${COLORS.amberChipText}; font-weight:bold; font-family:'Courier New',monospace; font-size:14px; padding:4px 10px; border-radius:6px;">${code}</span>`;
}

function projectUrl(crCode) {
  return `https://jarumiristudios.com/go/${crCode}`;
}

// A codeChip wrapped so it opens the project's page if the client is logged
// in and owns it, or the tracking page otherwise.
function codeChipLink(crCode) {
  return `<a href="${projectUrl(crCode)}" style="text-decoration:none;">${codeChip(crCode)}</a>`;
}

function detailsTable(rows) {
  const rowsHtml = rows.map(([label, value], i) => `
    <tr>
      <td style="padding:10px 14px; font-size:13px; color:${COLORS.muted}; border-top:${i === 0 ? "none" : `1px solid ${COLORS.border}`}; white-space:nowrap;">${label}</td>
      <td style="padding:10px 14px; font-size:13px; color:${COLORS.text}; font-weight:600; border-top:${i === 0 ? "none" : `1px solid ${COLORS.border}`}; text-align:right;">${value}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafafa; border:1px solid ${COLORS.border}; border-radius:8px; margin:18px 0;">${rowsHtml}</table>`;
}

function link(text, url) {
  return `<a href="${url}" style="color:${COLORS.amberDark}; text-decoration:underline;">${text}</a>`;
}

function signOff() {
  return `<p style="margin:28px 0 0; color:${COLORS.text};">&mdash; Jarumiri Studios</p>`;
}

// ---- Email templates --------------------------------------------------------

function sendBookingConfirmation(booking) {
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">Thank you for reaching out to Jarumiri Studios &mdash; we've received your booking request.</p>
    <p style="margin:0 0 4px; color:${COLORS.muted}; font-size:13px;">Your BR Code</p>
    <p style="margin:0 0 16px;">${codeChipLink(booking.crCode)}</p>
    <p style="margin:0 0 8px;">Please keep this code for your records. You can use it to check your project's status at any time on our tracking page.</p>
    ${button("Track your project →", projectUrl(booking.crCode))}
    <p style="margin:16px 0 0;">We'll review your brief and follow up shortly.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `We've received your request — ${booking.crCode}`,
    html: layout({ preheader: "We've received your booking request.", bodyHtml: body }),
  });
}

function sendAdminNewBookingAlert(booking) {
  const body = `
    <p style="margin:0 0 8px;">New booking submitted.</p>
    ${detailsTable([
      ["BR Code", codeChip(booking.crCode)],
      ["Name", booking.name],
      ["Email", booking.email],
      ["Location", booking.location],
      ["Service", booking.serviceType.join(", ")],
      ["Tier", booking.pricingTier],
    ])}
    ${button("View in admin dashboard →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `New booking request — ${booking.crCode}`,
    html: layout({ preheader: "New booking submitted.", bodyHtml: body }),
  });
}

function sendAdminNewApplicationAlert(application) {
  const body = `
    <p style="margin:0 0 8px;">New job application submitted.</p>
    ${detailsTable([
      ["Role", application.roleTitle],
      ["Name", application.name],
      ["Email", application.email],
      ["File", application.file?.originalName || "None"],
    ])}
    <p style="margin:16px 0 0; color:${COLORS.muted}; font-size:13px;">Message</p>
    <p style="margin:4px 0 0;">${application.message}</p>
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `New application — ${application.roleTitle}`,
    html: layout({ preheader: "New job application submitted.", bodyHtml: body }),
  });
}

function sendAcceptanceEmail(booking) {
  const payElsewhere = booking.clientId
    ? `${link("your tracking page", "https://jarumiristudios.com/track")} or ${link("account dashboard", "https://jarumiristudios.com/dashboard")}`
    : `${link("your tracking page", "https://jarumiristudios.com/track")}`;
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">We're pleased to let you know that your booking request has been reviewed and accepted.</p>
    <p style="margin:0 0 4px; color:${COLORS.muted}; font-size:13px;">BR Code</p>
    <p style="margin:0 0 16px;">${codeChipLink(booking.crCode)}</p>
    <p style="margin:0 0 8px;">A deposit invoice (30%) has been sent to this email address. Work will begin as soon as the deposit is received. If this email gets lost, you can also pay directly from ${payElsewhere} using your BR code &mdash; no need to wait on this invoice email.</p>
    <p style="margin:16px 0 0;">You can follow your project's status at any time on your tracking page using your BR code.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `Your request has been accepted — ${booking.crCode}`,
    html: layout({ preheader: "Your booking request has been accepted.", bodyHtml: body }),
  });
}

function sendAdminInvoiceAlert(booking, type, amount, invoiceUrl) {
  const label = PAYMENT_TYPE_LABELS[type] || type;
  const body = `
    <p style="margin:0 0 8px;">A Stripe invoice has been sent to the client.</p>
    ${detailsTable([
      ["Project", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
      ["Type", label],
      ["Amount", `$${amount.toFixed(2)}`],
    ])}
    ${invoiceUrl ? button("View Stripe invoice →", invoiceUrl) : ""}
    <p style="margin:8px 0 0;">${link("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}</p>
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Invoice sent — ${booking.crCode} (${label})`,
    html: layout({ preheader: "A Stripe invoice has been sent to the client.", bodyHtml: body }),
  });
}

function sendAdminPaymentAlert(booking, type, amount) {
  const label = PAYMENT_TYPE_LABELS[type] || type;
  const body = `
    <p style="margin:0 0 8px;">A Stripe payment has been confirmed.</p>
    ${detailsTable([
      ["Project", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
      ["Type", label],
      ["Amount", `$${amount.toFixed(2)}`],
    ])}
    ${button("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Payment received — ${booking.crCode} (${label})`,
    html: layout({ preheader: "A Stripe payment has been confirmed.", bodyHtml: body }),
  });
}

function sendAdminPauseAlert(booking) {
  const body = `
    <p style="margin:0 0 8px;">A client has put their project on hold.</p>
    ${detailsTable([
      ["Project", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
    ])}
    ${button("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Client paused project — ${booking.crCode}`,
    html: layout({ preheader: "A client has put their project on hold.", bodyHtml: body }),
  });
}

function sendDepositExpiredEmail(booking) {
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">The deposit deadline for your project (${codeChipLink(booking.crCode)}) has passed without payment, so we've placed it on hold.</p>
    <p style="margin:0;">We'd be glad to revisit this project &mdash; or take on a future one &mdash; whenever you're ready. Please don't hesitate to get in touch.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `Your project has been put on hold — ${booking.crCode}`,
    html: layout({ preheader: "Your project has been put on hold.", bodyHtml: body }),
  });
}

function sendAdminDepositExpiredAlert(booking) {
  const body = `
    <p style="margin:0 0 8px;">A project was automatically declined because its deposit due date passed without payment.</p>
    ${detailsTable([
      ["BR Code", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
    ])}
    ${button("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Auto-declined (unpaid deposit) — ${booking.crCode}`,
    html: layout({ preheader: "A project was auto-declined for an unpaid deposit.", bodyHtml: body }),
  });
}

function sendFinalExpiredEmail(booking) {
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">The due date for your final payment on project ${codeChipLink(booking.crCode)} has passed, so we've voided that invoice link for security.</p>
    <p style="margin:0;">No action needed right now &mdash; reach out whenever you're ready and we'll send a fresh payment link.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `Your final payment link has expired — ${booking.crCode}`,
    html: layout({ preheader: "Your final payment link has expired.", bodyHtml: body }),
  });
}

function sendAdminFinalExpiredAlert(booking) {
  const body = `
    <p style="margin:0 0 8px;">A final payment invoice was voided because its due date passed without payment.</p>
    ${detailsTable([
      ["BR Code", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
    ])}
    <p style="margin:12px 0 0; color:${COLORS.muted}; font-size:13px;">Final payment status has been reset so a new invoice can be sent when ready.</p>
    ${button("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Final invoice expired (unpaid) — ${booking.crCode}`,
    html: layout({ preheader: "A final payment invoice was voided (unpaid).", bodyHtml: body }),
  });
}

function sendProjectArchivedEmail(booking) {
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">Your project (${codeChipLink(booking.crCode)}) has been archived — the final payment window passed without a new invoice being sent.</p>
    <p style="margin:0;">Reach out whenever you're ready to pick it back up and we'll get it going again.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `Your project has been archived — ${booking.crCode}`,
    html: layout({ preheader: "Your project has been archived.", bodyHtml: body }),
  });
}

function sendAdminProjectArchivedAlert(booking) {
  const body = `
    <p style="margin:0 0 8px;">A project was automatically archived — its final invoice expired more than 3 days ago with no new invoice sent.</p>
    ${detailsTable([
      ["BR Code", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
    ])}
    ${button("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Auto-archived (final invoice stale) — ${booking.crCode}`,
    html: layout({ preheader: "A project was auto-archived after its final invoice expired.", bodyHtml: body }),
  });
}

function sendDepositReminderEmail(booking) {
  const payElsewhere = booking.clientId
    ? `${link("your tracking page", "https://jarumiristudios.com/track")} or ${link("account dashboard", "https://jarumiristudios.com/dashboard")}`
    : `${link("your tracking page", "https://jarumiristudios.com/track")}`;
  const dueDateStr = booking.depositDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">Just a reminder that the deposit for your project (${codeChipLink(booking.crCode)}) is due by <strong>${dueDateStr}</strong>. If it passes unpaid, the project will be put on hold.</p>
    <p style="margin:0;">You can pay from ${payElsewhere} using your BR code if you can't find the original invoice email.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `Reminder: deposit due tomorrow — ${booking.crCode}`,
    html: layout({ preheader: `Deposit due ${dueDateStr}.`, bodyHtml: body }),
  });
}

function sendFinalReminderEmail(booking) {
  const payElsewhere = booking.clientId
    ? `${link("your tracking page", "https://jarumiristudios.com/track")} or ${link("account dashboard", "https://jarumiristudios.com/dashboard")}`
    : `${link("your tracking page", "https://jarumiristudios.com/track")}`;
  const dueDateStr = booking.finalDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const body = `
    <p style="margin:0 0 16px;">Hi ${booking.name},</p>
    <p style="margin:0 0 16px;">Just a reminder that the final payment for your project (${codeChipLink(booking.crCode)}) is due by <strong>${dueDateStr}</strong>. If it passes unpaid, the payment link will be voided.</p>
    <p style="margin:0;">You can pay from ${payElsewhere} using your BR code if you can't find the original invoice email.</p>
    ${signOff()}
  `;
  return sendMail({
    to: booking.email,
    subject: `Reminder: final payment due tomorrow — ${booking.crCode}`,
    html: layout({ preheader: `Final payment due ${dueDateStr}.`, bodyHtml: body }),
  });
}

function sendPasswordResetEmail(user, rawToken) {
  const body = `
    <p style="margin:0 0 16px;">Hi${user.name ? " " + user.name : ""},</p>
    <p style="margin:0 0 8px;">We received a request to reset your Jarumiri Studios account password. Click below to choose a new one &mdash; this link expires in 1 hour.</p>
    ${button("Reset your password →", `https://jarumiristudios.com/reset-password/${rawToken}`)}
    <p style="margin:16px 0 0; color:${COLORS.muted}; font-size:13px;">If you didn't request this, you can safely ignore this email &mdash; your password won't be changed.</p>
    ${signOff()}
  `;
  return sendMail({
    to: user.email,
    subject: "Reset your password — Jarumiri Studios",
    html: layout({ preheader: "Reset your Jarumiri Studios password.", bodyHtml: body }),
  });
}

function sendSignupDiscountReminderEmail(user) {
  const expiresStr = user.discountExpiresAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const body = `
    <p style="margin:0 0 16px;">Hi${user.name ? " " + escapeHtml(user.name) : ""},</p>
    <p style="margin:0 0 16px;">Your ${user.discountPercent}% welcome discount is about to expire on <strong>${expiresStr}</strong>. Book your next project before then to use it.</p>
    ${button("Start a project →", "https://jarumiristudios.com/hire")}
    ${signOff()}
  `;
  return sendMail({
    to: user.email,
    subject: `Your ${user.discountPercent}% discount expires soon`,
    html: layout({ preheader: `Your welcome discount expires ${expiresStr}.`, bodyHtml: body }),
  });
}

function sendAdminUnexpectedPaymentAlert(booking, type, amount) {
  const label = PAYMENT_TYPE_LABELS[type] || type;
  const stateLabel = booking.archived ? "archived" : booking.status;
  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px; border-left:3px solid #ef4444; background-color:#fef2f2;">
      <tr><td style="padding:12px 16px; font-size:14px; color:#991b1b;">A Stripe payment came in for a project that is currently <strong>${stateLabel}</strong> &mdash; it was not auto-progressed. Please review manually.</td></tr>
    </table>
    ${detailsTable([
      ["Project", codeChip(booking.crCode)],
      ["Client", `${booking.name} (${booking.email})`],
      ["Type", label],
      ["Amount", `$${amount.toFixed(2)}`],
    ])}
    ${button("View project →", `https://jarumiristudios.com/admin/booking/${booking._id}`)}
  `;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `⚠ Payment received on inactive project — ${booking.crCode}`,
    html: layout({ preheader: "Payment received on an inactive project — needs manual review.", bodyHtml: body }),
  });
}

module.exports = { sendMail, sendBookingConfirmation, sendAdminNewBookingAlert, sendAdminNewApplicationAlert, sendAcceptanceEmail, sendAdminInvoiceAlert, sendAdminPaymentAlert, sendAdminPauseAlert, sendDepositExpiredEmail, sendAdminDepositExpiredAlert, sendFinalExpiredEmail, sendAdminFinalExpiredAlert, sendProjectArchivedEmail, sendAdminProjectArchivedAlert, sendDepositReminderEmail, sendFinalReminderEmail, sendAdminUnexpectedPaymentAlert, sendPasswordResetEmail, sendSignupDiscountReminderEmail };
