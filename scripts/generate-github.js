const GITHUB_API_BASE = "https://api.github.com";
const PRIMARY_QUERY_TERMS = [
  'agent',
  'llm',
  'rag',
  'gpt'
];
const SECONDARY_AI_TERMS = [
  'ai',
  'claude',
  'diffusion',
  'multimodal',
  'embedding',
  'copilot'
];
const EXCLUDED_TERMS = [
  'awesome',
  'tutorial',
  'prompt',
  'benchmark',
  'paper',
  'course'
];

function nowIso() {
  return new Date().toISOString();
}

function buildSearchQuery(date) {
  const keywordQuery = PRIMARY_QUERY_TERMS.map((term) => `${term} in:name,description`).join(' OR ');
  return `(${keywordQuery}) created:>=${date} fork:false archived:false`;
}

function hasAiSignal(repo) {
  const haystack = `${repo.name} ${repo.description || ''}`.toLowerCase();
  return SECONDARY_AI_TERMS.some((term) => haystack.includes(term))
    || PRIMARY_QUERY_TERMS.some((term) => haystack.includes(term));
}

function isExcluded(repo) {
  const haystack = `${repo.name} ${repo.description || ''}`.toLowerCase();
  return EXCLUDED_TERMS.some((term) => haystack.includes(term));
}

function normalizeTopics(repo) {
  return Array.isArray(repo.topics) ? repo.topics : [];
}

function normalizeRepo(repo) {
  return {
    source_id: repo.full_name,
    name: repo.name,
    tagline: repo.description || 'No description provided',
    url: repo.html_url,
    website_url: repo.homepage || null,
    rank: null,
    score: repo.stargazers_count,
    comments: null,
    stars: repo.stargazers_count,
    replies: null,
    created_at: repo.created_at,
    launched_at: null,
    topics: normalizeTopics(repo),
    raw_ref: {
      full_name: repo.full_name,
      language: repo.language,
      default_branch: repo.default_branch,
      pushed_at: repo.pushed_at,
      stargazers_count: repo.stargazers_count,
      watchers_count: repo.watchers_count,
      open_issues_count: repo.open_issues_count
    }
  };
}

async function fetchSearchResults(date, token) {
  const query = buildSearchQuery(date);
  const url = new URL(`${GITHUB_API_BASE}/search/repositories`);
  url.searchParams.set('q', query);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', '30');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ai-launch-radar-feed'
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub search failed: HTTP ${response.status} ${message}`);
  }

  return response.json();
}

export async function generateGithub(date) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      source: 'github',
      date,
      captured_at: nowIso(),
      status: 'unavailable',
      count: 0,
      notes: ['GITHUB_TOKEN is not configured'],
      items: []
    };
  }

  try {
    const payload = await fetchSearchResults(date, token);
    const repos = Array.isArray(payload.items) ? payload.items : [];
    const filtered = repos
      .filter((repo) => hasAiSignal(repo))
      .filter((repo) => !isExcluded(repo))
      .slice(0, 10)
      .map(normalizeRepo);

    return {
      source: 'github',
      date,
      captured_at: nowIso(),
      status: filtered.length > 0 ? 'ok' : 'degraded',
      count: filtered.length,
      notes: filtered.length > 0 ? [] : ['GitHub search returned no qualifying repositories'],
      items: filtered
    };
  } catch (error) {
    return {
      source: 'github',
      date,
      captured_at: nowIso(),
      status: 'unavailable',
      count: 0,
      notes: [error.message],
      items: []
    };
  }
}
