#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResult as inspectProductHuntHtml } from "./ph_inspect_html.mjs";

export const DEFAULT_CACHE_DIR = "C:/Users/kevin/AppData/Local/Temp/ai-launch-radar-cache";
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const PRODUCT_HUNT_HOST = "https://www.producthunt.com";
export const PRODUCT_HUNT_REASON_CODES = Object.freeze({
  MISSING_HTML: "ph_missing_html",
  HTML_BROWSER_CAPTURE_REQUIRED: "ph_html_browser_capture_required",
  HTML_NO_EXTRACTABLE_POSTS: "ph_html_no_extractable_posts",
  HAR_NO_EXTRACTABLE_POSTS: "ph_har_no_extractable_posts",
  HTTP_ERROR: "ph_http_error",
  NO_LIVE_SOURCE: "ph_no_live_source",
  NO_SOURCE_AVAILABLE: "ph_no_source_available",
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeDate(dateInput) {
  if (typeof dateInput !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    throw new Error("Invalid date: expected YYYY-MM-DD");
  }

  const [year, month, day] = dateInput.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid date: expected a real calendar date");
  }

  return { year, month, day, paddedMonth: pad2(month), paddedDay: pad2(day), isoDate: dateInput };
}

function toProductHuntDailyUrl(dateInput) {
  const { year, month, day } = normalizeDate(dateInput);
  return `${PRODUCT_HUNT_HOST}/leaderboard/daily/${year}/${month}/${day}`;
}

function toCachePath({ cacheDir, date }) {
  return path.posix.join(cacheDir, `producthunt-${date}.json`);
}

function parseJsonSafely(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function absoluteUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${PRODUCT_HUNT_HOST}${value}`;
  return null;
}

function slugFromValue(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const fromPostsPath = trimmed.match(/\/posts\/([^/?#]+)/i);
  if (fromPostsPath) return fromPostsPath[1];
  if (/^[a-z0-9-]+$/i.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

function websiteFromCandidate(candidate) {
  if (typeof candidate !== "string") return null;
  return absoluteUrl(candidate);
}

function normalizePostCandidate(candidate) {
  if (!isObject(candidate)) return null;

  const typename = typeof candidate.__typename === "string" ? candidate.__typename : null;
  const rawSlug = candidate.slug ?? slugFromValue(candidate.url) ?? slugFromValue(candidate.path);
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const tagline = typeof candidate.tagline === "string" ? candidate.tagline.trim() : "";
  const id = candidate.id == null ? null : String(candidate.id);
  const votesCount = Number.isFinite(candidate.votesCount) ? candidate.votesCount : (
    Number.isFinite(Number(candidate.votesCount)) ? Number(candidate.votesCount) : null
  );
  const websiteUrl = websiteFromCandidate(
    candidate.website ??
    candidate.websiteUrl ??
    candidate.redirectUrl ??
    candidate.externalUrl
  );
  const productHuntUrl = absoluteUrl(candidate.url) ?? (rawSlug ? `${PRODUCT_HUNT_HOST}/posts/${rawSlug}` : null);

  const looksLikePost =
    typename === "Post" ||
    ((Boolean(name) && Boolean(rawSlug)) && (Boolean(tagline) || productHuntUrl !== null || websiteUrl !== null));

  if (!looksLikePost || !name || !rawSlug) return null;

  return {
    id,
    name,
    tagline: tagline || null,
    slug: rawSlug,
    productHuntUrl,
    websiteUrl,
    votesCount,
  };
}

function collectPostsFromObject(root) {
  const found = [];
  const seen = new WeakSet();

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    const normalized = normalizePostCandidate(value);
    if (normalized) found.push(normalized);

    for (const nested of Object.values(value)) visit(nested);
  }

  visit(root);
  return dedupeAndSortItems(found);
}

function dedupeAndSortItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = item.id ?? item.slug ?? item.name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }

    const currentScore = existing.votesCount ?? -1;
    const nextScore = item.votesCount ?? -1;
    if (nextScore > currentScore) byKey.set(key, { ...existing, ...item });
    else byKey.set(key, { ...item, ...existing });
  }

  return [...byKey.values()].sort((left, right) => {
    const rightVotes = right.votesCount ?? -1;
    const leftVotes = left.votesCount ?? -1;
    if (rightVotes !== leftVotes) return rightVotes - leftVotes;
    return left.name.localeCompare(right.name);
  });
}

function extractBalancedLiteral(text, startIndex) {
  const opening = text[startIndex];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : null;
  if (!closing) return null;

  let depth = 0;
  let inString = false;
  let stringQuote = null;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
        stringQuote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === opening) depth += 1;
    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function extractJsonCandidatesFromHtml(html) {
  const candidates = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html))) {
    const scriptBody = match[1].trim();
    if (!scriptBody) continue;

    const directJson = parseJsonSafely(scriptBody);
    if (directJson) candidates.push(directJson);

    for (let index = 0; index < scriptBody.length; index += 1) {
      if (scriptBody[index] !== "=") continue;

      let literalStart = index + 1;
      while (literalStart < scriptBody.length && /\s/.test(scriptBody[literalStart])) literalStart += 1;
      if (scriptBody[literalStart] !== "{" && scriptBody[literalStart] !== "[") continue;

      const literal = extractBalancedLiteral(scriptBody, literalStart);
      if (!literal) continue;

      const parsed = parseJsonSafely(literal);
      if (parsed) {
        candidates.push(parsed);
        index = literalStart + literal.length - 1;
      }
    }
  }

  return candidates;
}

export function extractProductHuntEntriesFromHtml(html, { date = null, url = null } = {}) {
  if (typeof html !== "string" || !html.trim()) {
    return {
      status: "unavailable",
      items: [],
      reasonCode: PRODUCT_HUNT_REASON_CODES.MISSING_HTML,
      reason: "Missing Product Hunt HTML.",
      details: [],
      inspection: null,
      date,
      url,
    };
  }

  const inspection = inspectProductHuntHtml({ html, file: url ?? "<memory>" });
  const items = dedupeAndSortItems(
    extractJsonCandidatesFromHtml(html).flatMap((candidate) => collectPostsFromObject(candidate))
  );

  if (items.length > 0) {
    return {
      status: "ok",
      items,
      reasonCode: null,
      reason: null,
      details: [],
      inspection,
      date,
      url,
    };
  }

  if (inspection.needsBrowserCapture) {
    return {
      status: "degraded",
      items: [],
      reasonCode: PRODUCT_HUNT_REASON_CODES.HTML_BROWSER_CAPTURE_REQUIRED,
      reason: "Product Hunt HTML requires browser capture.",
      details: inspection.warnings ?? [],
      inspection,
      date,
      url,
    };
  }

  return {
    status: "unavailable",
    items: [],
    reasonCode: PRODUCT_HUNT_REASON_CODES.HTML_NO_EXTRACTABLE_POSTS,
    reason: "Product Hunt HTML did not contain extractable posts.",
    details: inspection.warnings ?? [],
    inspection,
    date,
    url,
  };
}

export function extractProductHuntEntriesFromHar(har) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const items = [];

  for (const entry of entries) {
    const rawText = entry?.response?.content?.text;
    if (typeof rawText !== "string" || !rawText.trim()) continue;
    const parsed = parseJsonSafely(rawText);
    if (!parsed) continue;
    items.push(...collectPostsFromObject(parsed));
  }

  const normalized = dedupeAndSortItems(items);
  if (normalized.length > 0) {
    return { status: "ok", items: normalized, reasonCode: null, reason: null, details: [] };
  }

  return {
    status: "unavailable",
    items: [],
    reasonCode: PRODUCT_HUNT_REASON_CODES.HAR_NO_EXTRACTABLE_POSTS,
    reason: "HAR did not contain extractable Product Hunt posts.",
    details: [],
  };
}

async function safeReadFile(fsOps, filePath) {
  try {
    return await fsOps.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readCache({ cachePath, fsOps }) {
  const raw = await safeReadFile(fsOps, cachePath);
  if (!raw) return null;

  const parsed = parseJsonSafely(raw);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  return parsed;
}

async function writeCache({ cachePath, payload, fsOps }) {
  await fsOps.mkdir(path.posix.dirname(cachePath), { recursive: true });
  await fsOps.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isFresh(record, nowIso, cacheTtlMs) {
  const fetchedAtMs = Date.parse(record?.fetchedAt ?? "");
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - fetchedAtMs <= cacheTtlMs;
}

// Read from config module if available
async function readSessionCookieFromConfig() {
  try {
    const configModule = await import("./config.mjs");
    const sessionValue = await configModule.default.getProductHuntSessionValue();
    return sessionValue;
  } catch {
    return null;
  }
}

async function readSessionCookie({ cookieFile, fsOps }) {
  // Check direct session value from config first
  const fromConfig = await readSessionCookieFromConfig();
  if (fromConfig) return fromConfig;

  if (!cookieFile) return null;
  const raw = await safeReadFile(fsOps, cookieFile);
  if (!raw) return null;

  const parsed = parseJsonSafely(raw);
  if (!Array.isArray(parsed)) {
    // If it's not an array, maybe it's just the raw value
    const trimmed = raw.trim();
    if (trimmed.length > 10) return trimmed;
    return null;
  }
  const session = parsed.find((entry) => entry?.name === "_producthunt_session_production");
  return typeof session?.value === "string" && session.value ? session.value : null;
}

function buildResponseFromCache({ record, cacheHit, staleCacheUsed, reasonCode = null, reason = null, details = [] }) {
  return {
    status: staleCacheUsed ? "degraded" : "ok",
    sourceType: "cache",
    cacheHit,
    staleCacheUsed,
    reasonCode: staleCacheUsed ? (reasonCode ?? PRODUCT_HUNT_REASON_CODES.NO_LIVE_SOURCE) : null,
    reason,
    details,
    fetchedAt: record.fetchedAt,
    items: dedupeAndSortItems(record.items),
  };
}

function buildFailureResponse({ reasonCode, reason, details = [], sourceType = "none", items = [] }) {
  return {
    status: items.length > 0 ? "degraded" : "unavailable",
    sourceType,
    cacheHit: false,
    staleCacheUsed: false,
    reasonCode,
    reason,
    details,
    fetchedAt: null,
    items,
  };
}

async function parseFromInputFiles({ htmlFile, harFile, jsonFile, fsOps, date }) {
  if (jsonFile) {
    const raw = await fsOps.readFile(jsonFile, "utf8");
    const parsed = parseJsonSafely(raw);
    const items = collectPostsFromObject(parsed);
    if (items.length > 0) {
      return {
        status: "ok",
        sourceType: "json-file",
        items,
        reasonCode: null,
        reason: null,
        details: [],
      };
    }
  }

  if (harFile) {
    const rawHar = await fsOps.readFile(harFile, "utf8");
    const harResult = extractProductHuntEntriesFromHar(parseJsonSafely(rawHar));
    if (harResult.status === "ok") {
      return { ...harResult, sourceType: "har-file" };
    }
  }

  if (htmlFile) {
    const html = await fsOps.readFile(htmlFile, "utf8");
    const htmlResult = extractProductHuntEntriesFromHtml(html, { date, url: htmlFile });
    if (htmlResult.status === "ok") {
      return { ...htmlResult, sourceType: "html-file" };
    }
    return { ...htmlResult, sourceType: "html-file" };
  }

  return null;
}

async function fetchLeaderboardHtml({ date, cookieFile, fetchImpl, fsOps }) {
  if (typeof fetchImpl !== "function") return null;

  const sessionCookie = await readSessionCookie({ cookieFile, fsOps });
  const url = toProductHuntDailyUrl(date);
  const headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml",
  };
  if (sessionCookie) headers.cookie = `_producthunt_session_production=${sessionCookie}`;

  const response = await fetchImpl(url, { headers });
  const statusCode = Number(response?.status ?? 0);
  const html = await response.text();
  return { statusCode, html, url };
}

export async function resolveProductHuntData({
  date,
  now = new Date().toISOString(),
  cacheDir = DEFAULT_CACHE_DIR,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  allowStaleCacheOnFailure = true,
  cookieFile = null,
  htmlFile = null,
  harFile = null,
  jsonFile = null,
  fetchImpl = null,
  fsOps = fs,
} = {}) {
  const normalizedDate = normalizeDate(date).isoDate;
  const cachePath = toCachePath({ cacheDir, date: normalizedDate });
  const cacheRecord = await readCache({ cachePath, fsOps });

  if (cacheRecord && isFresh(cacheRecord, now, cacheTtlMs)) {
    return buildResponseFromCache({ record: cacheRecord, cacheHit: true, staleCacheUsed: false });
  }

  const inputResult = await parseFromInputFiles({ htmlFile, harFile, jsonFile, fsOps, date: normalizedDate });
  if (inputResult?.status === "ok") {
    const payload = {
      fetchedAt: now,
      sourceType: inputResult.sourceType,
      items: inputResult.items,
    };
    await writeCache({ cachePath, payload, fsOps });
      return {
        status: "ok",
        sourceType: inputResult.sourceType,
        cacheHit: false,
        staleCacheUsed: false,
        reasonCode: null,
        reason: null,
        details: inputResult.details ?? [],
        fetchedAt: now,
      items: inputResult.items,
    };
  }

  if (inputResult && inputResult.status !== "ok") {
    if (cacheRecord && allowStaleCacheOnFailure) {
      return buildResponseFromCache({
        record: cacheRecord,
        cacheHit: false,
        staleCacheUsed: true,
        reasonCode: inputResult.reasonCode,
        reason: `${inputResult.reason} Falling back to stale cache.`,
        details: inputResult.details ?? [],
      });
    }
    return buildFailureResponse({
      reasonCode: inputResult.reasonCode,
      reason: inputResult.reason,
      details: inputResult.details ?? [],
      sourceType: inputResult.sourceType,
    });
  }

  const fetched = await fetchLeaderboardHtml({ date: normalizedDate, cookieFile, fetchImpl, fsOps });
  if (fetched) {
    if (fetched.statusCode >= 400) {
      if (cacheRecord && allowStaleCacheOnFailure) {
        return buildResponseFromCache({
          record: cacheRecord,
          cacheHit: false,
          staleCacheUsed: true,
          reasonCode: PRODUCT_HUNT_REASON_CODES.HTTP_ERROR,
          reason: `Product Hunt returned HTTP ${fetched.statusCode}. Falling back to stale cache.`,
          details: [],
        });
      }

      return buildFailureResponse({
        reasonCode: PRODUCT_HUNT_REASON_CODES.HTTP_ERROR,
        reason: `Product Hunt returned HTTP ${fetched.statusCode}.`,
        sourceType: "network-html",
      });
    }

    const htmlResult = extractProductHuntEntriesFromHtml(fetched.html, { date: normalizedDate, url: fetched.url });
    if (htmlResult.status === "ok") {
      const payload = {
        fetchedAt: now,
        sourceType: "network-html",
        items: htmlResult.items,
      };
      await writeCache({ cachePath, payload, fsOps });
      return {
        status: "ok",
        sourceType: "network-html",
        cacheHit: false,
        staleCacheUsed: false,
        reasonCode: null,
        reason: null,
        details: htmlResult.details ?? [],
        fetchedAt: now,
        items: htmlResult.items,
      };
    }

    if (cacheRecord && allowStaleCacheOnFailure) {
      return buildResponseFromCache({
        record: cacheRecord,
        cacheHit: false,
        staleCacheUsed: true,
        reasonCode: htmlResult.reasonCode,
        reason: `${htmlResult.reason} Falling back to stale cache.`,
        details: htmlResult.details ?? [],
      });
    }

    return buildFailureResponse({
      reasonCode: htmlResult.reasonCode,
      reason: htmlResult.reason,
      details: htmlResult.details ?? [],
      sourceType: "network-html",
    });
  }

  if (cacheRecord && allowStaleCacheOnFailure) {
    return buildResponseFromCache({
      record: cacheRecord,
      cacheHit: false,
      staleCacheUsed: true,
      reasonCode: PRODUCT_HUNT_REASON_CODES.NO_LIVE_SOURCE,
      reason: "No live Product Hunt source available. Falling back to stale cache.",
      details: [],
    });
  }

  return buildFailureResponse({
    reasonCode: PRODUCT_HUNT_REASON_CODES.NO_SOURCE_AVAILABLE,
    reason: "No Product Hunt source was available.",
    sourceType: "none",
  });
}

function parseArgs(argv) {
  const args = {
    date: new Date().toISOString().slice(0, 10),
    now: new Date().toISOString(),
    cacheDir: DEFAULT_CACHE_DIR,
    cacheTtlMinutes: 60,
    allowStaleCacheOnFailure: true,
    cookieFile: null,
    htmlFile: null,
    harFile: null,
    jsonFile: null,
    outputFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--date":
        args.date = argv[++i];
        break;
      case "--now":
        args.now = argv[++i];
        break;
      case "--cache-dir":
        args.cacheDir = argv[++i];
        break;
      case "--cache-ttl-minutes":
        args.cacheTtlMinutes = Number(argv[++i]);
        break;
      case "--cookie-file":
        args.cookieFile = argv[++i];
        break;
      case "--html-file":
        args.htmlFile = argv[++i];
        break;
      case "--har-file":
        args.harFile = argv[++i];
        break;
      case "--json-file":
        args.jsonFile = argv[++i];
        break;
      case "--output-file":
        args.outputFile = argv[++i];
        break;
      case "--no-stale-cache":
        args.allowStaleCacheOnFailure = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await resolveProductHuntData({
      date: args.date,
      now: args.now,
      cacheDir: args.cacheDir,
      cacheTtlMs: args.cacheTtlMinutes * 60 * 1000,
      allowStaleCacheOnFailure: args.allowStaleCacheOnFailure,
      cookieFile: args.cookieFile,
      htmlFile: args.htmlFile,
      harFile: args.harFile,
      jsonFile: args.jsonFile,
      fetchImpl: typeof fetch === "function" ? fetch : null,
    });

    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (args.outputFile) {
      await fs.mkdir(path.posix.dirname(args.outputFile), { recursive: true });
      await fs.writeFile(args.outputFile, output, "utf8");
    } else {
      process.stdout.write(output);
    }
    // Even on failure, exit with 0 - the caller handles status via the JSON
    process.exit(0);
  } catch (err) {
    // Handle any unexpected errors gracefully
    const errorResult = {
      status: "unavailable",
      sourceType: "error",
      cacheHit: false,
      staleCacheUsed: false,
      reasonCode: "ph_unexpected_error",
      reason: `Unexpected error: ${err.message}`,
      details: [],
      fetchedAt: null,
      items: [],
    };
    const output = `${JSON.stringify(errorResult, null, 2)}\n`;
    process.stderr.write(`ERROR: ${err.message}\n`);
    if (args.outputFile) {
      try {
        await fs.mkdir(path.posix.dirname(args.outputFile), { recursive: true });
        await fs.writeFile(args.outputFile, output, "utf8");
        // Wrote the error result, exit 0 so the pipeline continues
        process.exit(0);
      } catch {
        process.exit(1);
      }
    } else {
      process.stdout.write(output);
      // Still exit 0 to allow continuation
      process.exit(0);
    }
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${String(error?.message ?? error)}\n`);
    process.exit(1);
  });
}
