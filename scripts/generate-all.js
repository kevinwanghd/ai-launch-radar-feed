import fs from "node:fs/promises";
import path from "node:path";

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

async function generateGithub(date) {
  return {
    source: "github",
    date,
    captured_at: nowIso(),
    status: "ok",
    count: 1,
    notes: ["mock data for bootstrap"],
    items: [
      {
        source_id: "example/ai-repo",
        name: "AI Repo Example",
        tagline: "一个用于验证 launch radar feed 链路的示例 GitHub 项目",
        url: "https://github.com/example/ai-repo",
        website_url: null,
        rank: null,
        score: 120,
        comments: null,
        stars: 120,
        replies: null,
        created_at: `${date}T08:00:00Z`,
        launched_at: null,
        topics: ["ai", "agent", "demo"],
        raw_ref: {
          mock: true
        }
      }
    ]
  };
}

async function generateX(date) {
  return {
    source: "x",
    date,
    captured_at: nowIso(),
    status: "ok",
    count: 1,
    notes: ["mock data for bootstrap"],
    items: [
      {
        source_id: "tweet-001",
        name: "Agent Launch Example",
        tagline: "We just launched our AI workflow assistant. Feedback welcome.",
        url: "https://x.com/example/status/1234567890",
        website_url: "https://example.com",
        rank: null,
        score: 85,
        comments: null,
        stars: null,
        replies: 14,
        created_at: `${date}T09:30:00Z`,
        launched_at: `${date}T09:30:00Z`,
        topics: ["launch", "workflow", "assistant"],
        raw_ref: {
          mock: true
        }
      }
    ]
  };
}

async function generateProductHunt(date) {
  return {
    source: "producthunt",
    date,
    captured_at: nowIso(),
    status: "ok",
    count: 1,
    notes: ["mock data for bootstrap"],
    items: [
      {
        source_id: "ph-001",
        name: "Launch Radar Demo",
        tagline: "AI launch discovery for builders and writers",
        url: "https://www.producthunt.com/posts/launch-radar-demo",
        website_url: "https://example.com",
        rank: 7,
        score: 168,
        comments: 22,
        stars: null,
        replies: null,
        created_at: null,
        launched_at: `${date}T00:00:00Z`,
        topics: ["ai", "discovery", "productivity"],
        raw_ref: {
          mock: true
        }
      }
    ]
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
