// One-time seed: inserts the two roles that used to be hardcoded in views/public/index.ejs as real
// Role documents, so the DB-driven careers section isn't empty on first load. Safe to re-run —
// skips any title that already exists.
require("dotenv").config();
const mongoose = require("mongoose");
const Role = require("../models/Role");

const ROLES = [
  {
    title: "Video Editor",
    emoji: "🎬",
    description: "Comfortable cutting narrative content, managing pacing, and delivering clean timelines under a deadline. Experience with DaVinci Resolve or Premiere Pro is a strong plus. A portfolio of real work matters more than credentials.",
    requirements: ["Short-form & long-form editing", "Color grading fundamentals", "Ability to meet tight turnarounds"],
    order: 0,
  },
  {
    title: "Videographer",
    emoji: "🎥",
    description: "Someone who understands light, composition, and movement — and can bring that knowledge to a shoot without needing hand-holding. Familiarity with content creator environments is a bonus.",
    requirements: ["Strong sense of framing & composition", "Comfortable in fast-paced shoot environments", "Own gear is a plus, not a requirement"],
    order: 1,
  },
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  for (const role of ROLES) {
    const exists = await Role.exists({ title: role.title });
    if (exists) {
      console.log(`Skipping "${role.title}" — already exists.`);
      continue;
    }
    await Role.create(role);
    console.log(`Created "${role.title}".`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
