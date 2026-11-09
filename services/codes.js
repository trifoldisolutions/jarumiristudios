const BookingRequest = require("../models/BookingRequest");
const Application = require("../models/Application");

const CR_CODE_MAX_ATTEMPTS = 10;

async function generateCrCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  for (let attempt = 0; attempt < CR_CODE_MAX_ATTEMPTS; attempt++) {
    const r = rand();
    const code = `${r.slice(0, 3)}-${r.slice(3, 6)}-${r.slice(6, 9)}`;
    if (!(await BookingRequest.exists({ crCode: code }))) return code;
  }
  throw new Error(`Failed to generate a unique BR code after ${CR_CODE_MAX_ATTEMPTS} attempts`);
}

const APP_CODE_MAX_ATTEMPTS = 10;

async function generateAppCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  for (let attempt = 0; attempt < APP_CODE_MAX_ATTEMPTS; attempt++) {
    const r = rand();
    const code = `${r.slice(0, 3)}-${r.slice(3, 6)}-${r.slice(6, 9)}`;
    if (!(await Application.exists({ appCode: code }))) return code;
  }
  throw new Error(`Failed to generate a unique application code after ${APP_CODE_MAX_ATTEMPTS} attempts`);
}

module.exports = { generateCrCode, generateAppCode };
