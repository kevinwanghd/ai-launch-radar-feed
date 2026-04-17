import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const FEED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function nowIso() {
  return new Date().toISOString();
}

function normalizeDate(date) {
  if (!FEED_DATE_PATTERN.test(date)) {
    throw new Error("Invalid date: expected YYYY-MM-DD");
  }
  return date;
}

function emptyProductHuntExport(date, status, notes = []) {
  return {
    source: "producthunt",
    date,
    captured_at: nowIso(),
    status,
    count: 0,
    notes,
    items: []
  };
}

function normalizeProductHuntItem(item) {
  return {
    source_id: item.id ? String(item.id) : item.slug ?? item.name,
    name: item.name,
    tagline: item.tagline ?? null,
    url: item.productHuntUrl ?? null,
    website_url: item.websiteUrl ?? null,
    rank: item.rank ?? null,
    score: item.votesCount ?? null,
    comments: item.commentsCount ?? null,
    stars: null,
    replies: null,
    created_at: null,
    launched_at: item.launchedAt ?? null,
    topics: Array.isArray(item.topics) ? item.topics : [],
    raw_ref: {
      slug: item.slug ?? null,
      votesCount: item.votesCount ?? null,
      productHuntUrl: item.productHuntUrl ?? null,
      websiteUrl: item.websiteUrl ?? null
    }
  };
}

async function runProvider(date, outputFile) {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), "scripts", "producthunt_provider.mjs");
    const args = [scriptPath, "--date", date, "--output-file", outputFile];

    if (process.env.PRODUCT_HUNT_COOKIE_FILE) {
      args.push("--cookie-file", process.env.PRODUCT_HUNT_COOKIE_FILE);
    }

    const proc = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
  });
}

export async function generateProductHunt(date) {
  const normalizedDate = normalizeDate(date);
  const hasCookieFile = Boolean(process.env.PRODUCT_HUNT_COOKIE_FILE);

  if (!hasCookieFile) {
    return emptyProductHuntExport(normalizedDate, "unavailable", [
      "PRODUCT_HUNT_COOKIE_FILE is not configured"
    ]);
  }

  const outputFile = path.join(process.cwd(), "data", normalizedDate, "producthunt-raw.json");
  const result = await runProvider(normalizedDate, outputFile);

  try {
    const raw = await fs.readFile(outputFile, "utf8");
    const providerResult = JSON.parse(raw);
    const items = Array.isArray(providerResult.items)
      ? providerResult.items.map(normalizeProductHuntItem)
      : [];

    const notes = [];
    if (providerResult.reason) notes.push(providerResult.reason);
    if (providerResult.reasonCode) notes.push(`reason_code:${providerResult.reasonCode}`);
    if (providerResult.staleCacheUsed) notes.push("stale cache used");

    const status = providerResult.status === "ok"
      ? "ok"
      : providerResult.status === "degraded"
        ? "degraded"
        : "unavailable";

    return {
      source: "producthunt",
      date: normalizedDate,
      captured_at: nowIso(),
      status,
      count: items.length,
      notes,
      items,
    };
  } catch (error) {
    const baseNotes = [];
    if (result.stderr) baseNotes.push(result.stderr.trim().split("\n")[0]);
    baseNotes.push(`provider output read failed: ${error.message}`);
    return emptyProductHuntExport(normalizedDate, "unavailable", baseNotes);
  } finally {
    await fs.rm(outputFile, { force: true }).catch(() => {});
  }
}
