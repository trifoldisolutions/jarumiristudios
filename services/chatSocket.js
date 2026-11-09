const { Server } = require("socket.io");
const BookingRequest = require("../models/BookingRequest");

// Attached to the HTTP server in server.js.
const io = new Server();

function chatRoom(bookingId) {
  return `project:${bookingId}`;
}

// Project chat — a socket only ever represents one project's thread (opened from either
// /dashboard/messages/:id or /admin/booking/:id), so authorization happens once at connect
// time rather than per-event. Sending still goes through normal HTTP POST routes in routes/ (multer
// needs a real request); this socket is push-only, used to broadcast those saved messages live.
io.on("connection", async (socket) => {
  const session = socket.request.session;
  const bookingId = socket.handshake.query.bookingId;
  if (!bookingId) return socket.disconnect(true);

  let authorized = false;
  if (session?.isAdmin) {
    authorized = await BookingRequest.exists({ _id: bookingId });
  } else if (session?.userId) {
    authorized = await BookingRequest.exists({ _id: bookingId, clientId: session.userId });
  } else if (session?.associateId) {
    authorized = await BookingRequest.exists({ _id: bookingId, assignedTo: session.associateId });
  }
  if (!authorized) return socket.disconnect(true);

  socket.join(chatRoom(bookingId));
});

module.exports = { io, chatRoom };
