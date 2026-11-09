const dotenv = require("dotenv");
dotenv.config(); // must run before any local require() that reads process.env at module load time (e.g. services/r2.js)
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const cookieParser = require("cookie-parser");
const http = require("http");
const { startInvoiceExpiryJob } = require("./services/invoiceExpiry");
const { startDiscountExpiryJob } = require("./services/discountExpiry");
const stripe = require("./services/stripe");
const { io } = require("./services/chatSocket");
const { sessionMiddleware } = require("./middleware/auth");
const { assignVisitorId } = require("./middleware/visitor");
const { skipOptions } = require("./middleware/skipOptions");

const app = express();
// Railway/Cloudflare terminate TLS in front of the app — trust their proxy so
// secure cookies and req.secure reflect the real (https) protocol.
app.set("trust proxy", 1);
const httpServer = http.createServer(app);
io.attach(httpServer);
const PORT = process.env.PORT || 3000;

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Before express.json(): the Stripe webhook needs the raw body for signature verification
const webhooks = { name: "Webhooks", mount: "/webhooks", router: require("./routes/webhooks") };
app.use(webhooks.mount, skipOptions(webhooks.router));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());
app.use(assignVisitorId);
app.use(sessionMiddleware);
// Shares the same express-session with Socket.IO so a socket's handshake carries req.session
io.engine.use(sessionMiddleware);

// Database
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    startInvoiceExpiryJob(stripe);
    startDiscountExpiryJob();
  })
  .catch((err) => console.error("MongoDB error:", err));

// Facades
const facades = [
  { name: "Public", mount: "/", router: require("./routes/public") },
  { name: "App", mount: "/", router: require("./routes/app") },
  { name: "Admin", mount: "/admin", router: require("./routes/admin") },
  { name: "Associate", mount: "/associate", router: require("./routes/associate") },
  { name: "API", mount: "/api", router: require("./routes/api") },
];

facades.forEach(({ mount, router }) => app.use(mount, skipOptions(router)));

// Catch-all for any request that didn't match a route above.
app.use((req, res) => {
  res.status(404).render("public/404");
});

// Safety net for anything upstream that calls next(err) without its own handling
// (e.g. a Multer error on a route without a bespoke wrapper) — avoids leaking a stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).send("Something went wrong. Please go back and try again.");
});

httpServer.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`Server running on ${base}\n`);
  [webhooks, ...facades].forEach(({ name, mount, router }) => {
    console.log(`[${name}]`);
    (router.routes || []).forEach(({ method, path: p, label }) => {
      const full = (mount === "/" ? "" : mount) + (p === "/" && mount !== "/" ? "" : p);
      console.log(`  ${method.padEnd(6)} ${base}${full || "/"} — ${label}`);
    });
  });
  console.log("");
});
