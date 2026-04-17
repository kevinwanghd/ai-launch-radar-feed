#!/usr/bin/env node
/**
 * Product Hunt HTML inspector (no network).
 *
 * Purpose:
 * - Detect Cloudflare / bot-challenge markers.
 * - Detect Apollo SSR transport presence.
 * - Extract known operation names when they appear (best-effort).
 * - Detect whether the SSR payload already contains non-empty leaderboard edges.
 *
 * Exit codes:
 * - 0: parsed successfully, no blockers detected
 * - 2: bot/challenge detected (requires real browser capture / HAR / Claude-in-Chrome)
 * - 1: input/parse error
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = { file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[i + 1] ?? null;
  }
  return out;
}

function unique(arr) {
  return [...new Set(arr)];
}

export function detectCloudflareMarkers(html) {
  const markers = [];
  const checks = [
    { key: "/cdn-cgi/challenge-platform/", label: "cdn-cgi-challenge-platform" },
    { key: "challenges.cloudflare.com", label: "cloudflare-challenges-host" },
    { key: "__CF$cv$params", label: "cf-cv-params" },
    { key: "cf-chl", label: "cf-chl" },
    { key: "Just a moment", label: "cf-just-a-moment" },
    { key: "Performing security verification", label: "security-verification-text" },
  ];
  for (const c of checks) {
    if (html.includes(c.key)) markers.push(c.label);
  }
  return unique(markers);
}

export function detectApolloTransport(html) {
  const hasApolloSymbol = html.includes("ApolloSSRDataTransport");
  // Some pages may contain next_f rehydration without Apollo. Keep this as a secondary hint.
  const hasNextF = html.includes("self.__next_f.push");
  return { present: hasApolloSymbol, hasApolloSymbol, hasNextF };
}

export function extractOperationNames(html) {
  // Best-effort: extract occurrences like "query LeaderboardDailyPage(" from embedded strings.
  const ops = [];

  const re = /query\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(html))) {
    ops.push(m[1]);
    if (ops.length >= 50) break;
  }

  // Also look for obvious operation names embedded without the full query string.
  const known = ["LeaderboardDailyPage", "LeaderboardCommonFragment", "LeaderboardPostListFragment"];
  for (const k of known) {
    if (html.includes(k)) ops.push(k);
  }

  return unique(ops);
}

export function detectHomefeedEdgesSignal(html) {
  const idx = html.indexOf('"homefeedItems"');
  if (idx === -1) return { homefeedEdgesEmpty: null, homefeedEdgeCount: null, evidence: [] };

  // Narrow window around the first appearance to avoid scanning full file for regex matches.
  const windowStart = Math.max(0, idx - 5000);
  const windowEnd = Math.min(html.length, idx + 20000);
  const slice = html.slice(windowStart, windowEnd);

  const evidence = [];

  if (slice.includes('"edges":[]')) {
    evidence.push('edges:[]');
    return { homefeedEdgesEmpty: true, homefeedEdgeCount: 0, evidence };
  }

  // Count minimal edge markers in the vicinity.
  const edgeMatches = slice.match(/\"edges\":\[/g) ?? [];
  const nodeMatches = slice.match(/\"__typename\":\"Post\"/g) ?? [];
  if (edgeMatches.length > 0) evidence.push(`edgesArrays:${edgeMatches.length}`);
  if (nodeMatches.length > 0) evidence.push(`postTypenames:${nodeMatches.length}`);

  if (nodeMatches.length > 0) {
    // We can't reliably compute edge count without parsing JSON, but non-zero Post typenames is a strong hint.
    return { homefeedEdgesEmpty: false, homefeedEdgeCount: null, evidence };
  }

  return { homefeedEdgesEmpty: null, homefeedEdgeCount: null, evidence };
}

export function buildResult({ html, file }) {
  const blockers = [];
  const cfMarkers = detectCloudflareMarkers(html);
  if (cfMarkers.length > 0) {
    blockers.push({ type: "cloudflare_challenge", markers: cfMarkers });
  }

  const apollo = detectApolloTransport(html);
  const operations = apollo.present ? extractOperationNames(html) : [];
  const signals = detectHomefeedEdgesSignal(html);

  const warnings = [];
  if (blockers.length > 0) warnings.push("Bot/challenge markers detected; SSR payload may be incomplete.");
  if (apollo.present && signals.homefeedEdgesEmpty === true) warnings.push("Apollo SSR present but homefeedItems.edges is empty in captured HTML.");
  if (!apollo.present) warnings.push("Apollo SSR transport not found; cannot extract leaderboard entities from HTML reliably.");

  return {
    file,
    needsBrowserCapture: blockers.length > 0 || signals.homefeedEdgesEmpty === true,
    blockers,
    apollo: { ...apollo, operations },
    signals,
    warnings,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    process.stderr.write("ERROR: missing --file\n");
    process.exit(1);
  }

  let html;
  try {
    html = fs.readFileSync(args.file, "utf8");
  } catch (e) {
    process.stderr.write(`ERROR: cannot read file: ${String(e?.message ?? e)}\n`);
    process.exit(1);
  }

  const res = buildResult({ html, file: args.file });
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");

  process.exit(res.needsBrowserCapture ? 2 : 0);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    process.stderr.write(`ERROR: ${String(e?.stack ?? e)}\n`);
    process.exit(1);
  });
}
