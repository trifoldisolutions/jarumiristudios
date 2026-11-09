const { MIN_DUE_DATE_LEAD_DAYS } = require("../config/limits");

function endOfDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59Z`);
  return isNaN(d.getTime()) ? null : d;
}

// Inclusive list of "YYYY-MM" keys spanning two dates, oldest first.
function monthKeysBetween(fromDate, toDate) {
  const keys = [];
  const cur = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));
  while (cur <= end) {
    keys.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return keys;
}

function monthKeyLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function minDueDate() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + MIN_DUE_DATE_LEAD_DAYS);
  return d;
}

module.exports = { endOfDay, monthKeysBetween, monthKeyLabel, minDueDate };
