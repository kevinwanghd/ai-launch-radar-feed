import fs from "node:fs/promises";
import path from "node:path";
import { generateGithub } from "./generate-github.js";
import { generateProductHunt } from "./generate-producthunt.js";
import { generateX } from "./generate-x.js";

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function emptySourceExport(source, date, notes = []) {
  return {
    source,
    date,
    captured_at: nowIso(),
    status: "unavailable",
    count: 0,
    notes,
    items: [],
  };
}

function buildRunSummary(date, github, x, producthunt) {
  const statuses = [github.status, x.status, producthunt.status];
  const overall_status = statuses.every((s) => s === "ok") ? "ok" : "degraded";

  return {
    date,
    captured_at: nowIso(),
    overall_status,
    sources: {
      github: { status: github.status, count: github.count },
      x: { status: x.status, count: x.count },
      producthunt: { status: producthunt.status, count: producthunt.count }
    },
    report_path: null
  };
}

async function main() {
  const date = process.env.FEED_DATE || todayDate();
  const outputDir = path.join(process.cwd(), "data", date);

  await ensureDir(outputDir);

  let github;
  let x;
  let producthunt;

  try {
    github = await generateGithub(date);
  } catch (error) {
    github = emptySourceExport("github", date, [`generator failed: ${error.message}`]);
  }

  try {
    x = await generateX(date);
  } catch (error) {
    x = emptySourceExport("x", date, [`generator failed: ${error.message}`]);
  }

  try {
    producthunt = await generateProductHunt(date);
  } catch (error) {
    producthunt = emptySourceExport("producthunt", date, [`generator failed: ${error.message}`]);
  }

  const runSummary = buildRunSummary(date, github, x, producthunt);

  await writeJson(path.join(outputDir, "github.json"), github);
  await writeJson(path.join(outputDir, "x.json"), x);
  await writeJson(path.join(outputDir, "producthunt.json"), producthunt);
  await writeJson(path.join(outputDir, "run-summary.json"), runSummary);

  console.log(`Feed generated at data/${date}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
