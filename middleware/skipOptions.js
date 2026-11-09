// A mounted router answers OPTIONS itself (200 with an Allow header) on any path it has a route
// for. With every route inline in server.js, OPTIONS always fell through to the 404 handler, so
// each router is mounted through this to keep that behavior.
function skipOptions(router) {
  return function skipOptionsMount(req, res, next) {
    if (req.method === "OPTIONS") return next();
    return router(req, res, next);
  };
}

module.exports = { skipOptions };
