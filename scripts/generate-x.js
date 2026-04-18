import { spawn } from "node:child_process";
import path from "node:path";

const FEED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_QUERIES = [
  "just launched AI",
  "we launched AI",
  "now live AI",
  "built this AI"
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeDate(date) {
  if (!FEED_DATE_PATTERN.test(date)) {
    throw new Error("Invalid date: expected YYYY-MM-DD");
  }
  return date;
}

function emptyXExport(date, status, notes = []) {
  return {
    source: "x",
    date,
    captured_at: nowIso(),
    status,
    count: 0,
    notes,
    items: []
  };
}

function summarizeTweetText(text) {
  if (typeof text !== "string" || !text.trim()) return "No text available";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function inferTopics(text) {
  if (typeof text !== "string") return [];
  const lowered = text.toLowerCase();
  const topics = [];
  if (lowered.includes("agent")) topics.push("agent");
  if (lowered.includes("workflow")) topics.push("workflow");
  if (lowered.includes("rag")) topics.push("rag");
  if (lowered.includes("llm")) topics.push("llm");
  if (lowered.includes("launch")) topics.push("launch");
  return topics;
}

function isCredibleLaunchTweet(tweet) {
  if (!tweet || typeof tweet !== "object") return false;
  if (!tweet.id || !tweet.url || !tweet.username) return false;
  if (!tweet.text || typeof tweet.text !== "string") return false;

  const text = tweet.text.toLowerCase();
  return ["launch", "launched", "now live", "built this", "shipping"].some((term) => text.includes(term));
}

function normalizeTweet(tweet) {
  return {
    source_id: String(tweet.id),
    name: tweet.username,
    tagline: summarizeTweetText(tweet.text),
    url: tweet.url,
    website_url: null,
    rank: null,
    score: Number(tweet.likes || 0) + Number(tweet.retweets || 0) * 2,
    comments: null,
    stars: null,
    replies: Number(tweet.replies || 0),
    created_at: tweet.date ? `${tweet.date}T00:00:00Z` : null,
    launched_at: tweet.date ? `${tweet.date}T00:00:00Z` : null,
    topics: inferTopics(tweet.text),
    raw_ref: {
      username: tweet.username,
      likes: Number(tweet.likes || 0),
      retweets: Number(tweet.retweets || 0),
      replies: Number(tweet.replies || 0)
    }
  };
}

async function runXSearch(query) {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), "scripts", "x_search.py");
    const proc = spawn("python", [scriptPath, query, "20"], {
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

function parseTweetsFromStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

export async function generateX(date) {
  const normalizedDate = normalizeDate(date);
  const hasCredentials = Boolean(process.env.X_AUTH_TOKEN && process.env.X_CT0);

  if (!hasCredentials) {
    return emptyXExport(normalizedDate, "unavailable", [
      "X_AUTH_TOKEN and X_CT0 are not configured"
    ]);
  }

  const allTweets = [];
  const notes = [];

  for (const query of SEARCH_QUERIES) {
    const result = await runXSearch(query);
    if (result.code !== 0) {
      if (result.stderr) notes.push(result.stderr.trim().split("\n")[0]);
      continue;
    }

    try {
      const tweets = parseTweetsFromStdout(result.stdout);
      allTweets.push(...tweets);
    } catch (error) {
      notes.push(`failed to parse X search output for query \"${query}\": ${error.message}`);
    }
  }

  const byId = new Map();
  for (const tweet of allTweets) {
    if (!isCredibleLaunchTweet(tweet)) continue;
    byId.set(String(tweet.id), tweet);
  }

  const items = [...byId.values()].slice(0, 20).map(normalizeTweet);

  if (items.length === 0) {
    return emptyXExport(normalizedDate, notes.length > 0 ? "degraded" : "unavailable", [
      ...notes,
      "No trustworthy launch-intent tweets found"
    ]);
  }

  return {
    source: "x",
    date: normalizedDate,
    captured_at: nowIso(),
    status: notes.length > 0 ? "degraded" : "ok",
    count: items.length,
    notes,
    items
  };
}
