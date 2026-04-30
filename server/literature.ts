/**
 * Unified literature search engine with 5 data sources:
 * arXiv, Semantic Scholar, Springer, PubMed, CrossRef
 */
import { ENV } from "./_core/env";

export interface LiteratureResult {
  paperId: string;
  title: string;
  authors: string;
  year: number | null;
  abstract: string;
  venue: string;
  citationCount: number;
  doi: string;
  arxivId: string;
  url: string;
  source: string;
  bibtex: string;
}

const fetchWithRetry = async (url: string, options: RequestInit = {}, retries = 2): Promise<Response> => {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (res.ok) return res;
      if (i === retries) return res;
    } catch (e) {
      if (i === retries) throw e;
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error("Fetch failed after retries");
};

const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "between", "about", "using", "study",
  "analysis", "research", "effects", "effect", "based", "approach", "model", "models",
  "method", "methods", "data", "paper", "review", "framework", "toward", "towards",
]);

function normalizeText(input: string): string {
  return (input || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(query: string): string[] {
  const tokens = normalizeText(query)
    .split(" ")
    .filter((t) => t.length >= 3 && !QUERY_STOP_WORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 12);
}

function buildDedupKey(result: LiteratureResult): string {
  if (result.doi) return `doi:${result.doi.toLowerCase()}`;
  if (result.arxivId) return `arxiv:${result.arxivId.toLowerCase()}`;
  return `title:${normalizeText(result.title).replace(/\s/g, "").slice(0, 120)}`;
}

function scoreResultRelevance(result: LiteratureResult, queryTerms: string[]): number {
  const title = normalizeText(result.title);
  const abs = normalizeText(result.abstract);
  const venue = normalizeText(result.venue);
  const currentYear = new Date().getFullYear();

  let score = 0;
  for (const term of queryTerms) {
    if (title.includes(term)) score += 4.0;
    if (abs.includes(term)) score += 1.5;
    if (venue.includes(term)) score += 0.5;
  }

  if (result.abstract && result.abstract.length > 120) score += 0.8;
  if (result.doi) score += 0.5;

  const citationBoost = Math.min(2.5, Math.log10((result.citationCount || 0) + 1));
  score += citationBoost;

  if (result.year) {
    const age = currentYear - result.year;
    if (age <= 5) score += 1.0;
    else if (age <= 10) score += 0.5;
    else if (age > 30) score -= 0.5;
  }

  if (result.source === "semantic_scholar" || result.source === "pubmed") score += 0.2;
  if (queryTerms.length === 0) score += 0.5; // Avoid collapsing scores when query is very generic.

  return score;
}

function pickBetterResult(
  current: LiteratureResult,
  candidate: LiteratureResult,
  currentScore: number,
  candidateScore: number
): { best: LiteratureResult; score: number } {
  const candidateWins =
    candidateScore > currentScore + 0.25 ||
    (Math.abs(candidateScore - currentScore) <= 0.25 && (candidate.citationCount || 0) > (current.citationCount || 0));

  const primary = candidateWins ? candidate : current;
  const secondary = candidateWins ? current : candidate;
  const bestScore = candidateWins ? candidateScore : currentScore;

  return {
    best: {
      ...primary,
      doi: primary.doi || secondary.doi,
      arxivId: primary.arxivId || secondary.arxivId,
      abstract: (primary.abstract || "").length >= (secondary.abstract || "").length ? primary.abstract : secondary.abstract,
      venue: primary.venue || secondary.venue,
      url: primary.url || secondary.url,
      bibtex: primary.bibtex || secondary.bibtex,
    },
    score: bestScore,
  };
}

// ─── arXiv ───
export async function searchArxiv(query: string, maxResults = 10): Promise<LiteratureResult[]> {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=relevance`;
  const res = await fetchWithRetry(url);
  const xml = await res.text();

  const results: LiteratureResult[] = [];
  const entries = xml.split("<entry>").slice(1);

  for (const entry of entries) {
    const get = (tag: string) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : "";
    };
    const id = get("id").replace("http://arxiv.org/abs/", "").replace(/v\d+$/, "");
    const authors = Array.from(entry.matchAll(/<name>([^<]+)<\/name>/g)).map(m => m[1]).join(", ");
    const published = get("published");
    const year = published ? parseInt(published.substring(0, 4)) : null;

    results.push({
      paperId: `arxiv:${id}`,
      title: get("title").replace(/\s+/g, " "),
      authors,
      year,
      abstract: get("summary").replace(/\s+/g, " "),
      venue: "arXiv",
      citationCount: 0,
      doi: "",
      arxivId: id,
      url: `https://arxiv.org/abs/${id}`,
      source: "arxiv",
      bibtex: `@article{arxiv_${id.replace(/[./]/g, "_")},\n  title={${get("title").replace(/\s+/g, " ")}},\n  author={${authors}},\n  journal={arXiv preprint arXiv:${id}},\n  year={${year}}\n}`,
    });
  }
  return results;
}

// ─── Semantic Scholar ───
export async function searchSemanticScholar(query: string, maxResults = 10, apiKey?: string): Promise<LiteratureResult[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=paperId,title,authors,year,abstract,venue,citationCount,externalIds,url`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) return [];
  const data = await res.json() as any;

  return (data.data || []).map((p: any) => ({
    paperId: `s2:${p.paperId}`,
    title: p.title || "",
    authors: (p.authors || []).map((a: any) => a.name).join(", "),
    year: p.year || null,
    abstract: p.abstract || "",
    venue: p.venue || "",
    citationCount: p.citationCount || 0,
    doi: p.externalIds?.DOI || "",
    arxivId: p.externalIds?.ArXiv || "",
    url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
    source: "semantic_scholar",
    bibtex: `@article{s2_${p.paperId?.substring(0, 12)},\n  title={${p.title || ""}},\n  author={${(p.authors || []).map((a: any) => a.name).join(" and ")}},\n  year={${p.year || ""}},\n  journal={${p.venue || ""}}\n}`,
  }));
}

// ─── Springer ───
export async function searchSpringer(query: string, maxResults = 10, apiKey?: string): Promise<LiteratureResult[]> {
  if (!apiKey) return [];
  const url = `https://api.springernature.com/meta/v2/json?q=${encodeURIComponent(query)}&s=1&p=${maxResults}&api_key=${apiKey}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return [];
  const data = await res.json() as any;

  return (data.records || []).map((r: any) => {
    const doi = r.doi || "";
    const authors = (r.creators || []).map((c: any) => c.creator).join(", ");
    const year = r.publicationDate ? parseInt(r.publicationDate.substring(0, 4)) : null;
    return {
      paperId: `springer:${doi || r.identifier}`,
      title: r.title || "",
      authors,
      year,
      abstract: r.abstract || "",
      venue: r.publicationName || "",
      citationCount: 0,
      doi,
      arxivId: "",
      url: (r.url || [{ value: "" }])[0]?.value || `https://doi.org/${doi}`,
      source: "springer",
      bibtex: `@article{springer_${(doi || "").replace(/[./]/g, "_")},\n  title={${r.title || ""}},\n  author={${authors}},\n  journal={${r.publicationName || ""}},\n  year={${year}},\n  doi={${doi}}\n}`,
    };
  });
}

// ─── PubMed ───
export async function searchPubMed(query: string, maxResults = 10): Promise<LiteratureResult[]> {
  // Step 1: search for IDs
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;
  const searchRes = await fetchWithRetry(searchUrl);
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json() as any;
  const ids = searchData.esearchresult?.idlist || [];
  if (ids.length === 0) return [];

  // Step 2: fetch details
  const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`;
  const fetchRes = await fetchWithRetry(fetchUrl);
  const xml = await fetchRes.text();

  const results: LiteratureResult[] = [];
  const articles = xml.split("<PubmedArticle>").slice(1);

  for (const article of articles) {
    const get = (tag: string) => {
      const m = article.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : "";
    };
    const pmid = get("PMID");
    if (!pmid) continue; // Skip entries with empty PMID
    const title = get("ArticleTitle");
    if (!title || title.trim().length < 5) continue; // Skip entries with missing/short titles
    const abs = get("AbstractText");
    const year = get("Year");
    const journal = get("Title");
    const authorNames = Array.from(article.matchAll(/<LastName>([^<]+)<\/LastName>\s*<ForeName>([^<]+)<\/ForeName>/g))
      .map(m => `${m[2]} ${m[1]}`).join(", ");
    if (!authorNames) continue; // Skip entries with no authors
    const doiMatch = article.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/);
    const doi = doiMatch ? doiMatch[1] : "";

    results.push({
      paperId: `pubmed:${pmid}`,
      title,
      authors: authorNames,
      year: year ? parseInt(year) : null,
      abstract: abs,
      venue: journal,
      citationCount: 0,
      doi,
      arxivId: "",
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      source: "pubmed",
      bibtex: `@article{pubmed_${pmid},\n  title={${title}},\n  author={${authorNames}},\n  journal={${journal}},\n  year={${year}},\n  doi={${doi}}\n}`,
    });
  }
  return results;
}

// ─── CrossRef ───
export async function searchCrossRef(query: string, maxResults = 10): Promise<LiteratureResult[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}&select=DOI,title,author,published-print,abstract,container-title,is-referenced-by-count`;
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": "AutoResearch/1.0 (mailto:research@example.com)" }
  });
  if (!res.ok) return [];
  const data = await res.json() as any;

  return (data.message?.items || []).map((item: any) => {
    const doi = item.DOI || "";
    const title = (item.title || [""])[0] || "";
    const authors = (item.author || []).map((a: any) => `${a.given || ""} ${a.family || ""}`.trim()).join(", ");
    const dateParts = item["published-print"]?.["date-parts"]?.[0] || [];
    const year = dateParts[0] || null;
    const venue = (item["container-title"] || [""])[0] || "";

    return {
      paperId: `crossref:${doi}`,
      title,
      authors,
      year,
      abstract: (item.abstract || "").replace(/<[^>]*>/g, ""),
      venue,
      citationCount: item["is-referenced-by-count"] || 0,
      doi,
      arxivId: "",
      url: `https://doi.org/${doi}`,
      source: "crossref",
      bibtex: `@article{crossref_${doi.replace(/[./]/g, "_")},\n  title={${title}},\n  author={${authors}},\n  journal={${venue}},\n  year={${year}},\n  doi={${doi}}\n}`,
    };
  });
}

// ─── Unified Search with Deduplication ───
export interface SearchOptions {
  maxPerSource?: number;
  semanticScholarApiKey?: string;
  springerApiKey?: string;
  sources?: {
    arxiv?: boolean;
    semanticScholar?: boolean;
    springer?: boolean;
    pubmed?: boolean;
    crossref?: boolean;
  };
}

export async function unifiedSearch(query: string, options: SearchOptions = {}): Promise<LiteratureResult[]> {
  const { maxPerSource = 10, sources = {} } = options;
  const enabledSources = {
    arxiv: sources.arxiv !== false,
    semanticScholar: sources.semanticScholar !== false,
    springer: sources.springer !== false,
    pubmed: sources.pubmed !== false,
    crossref: sources.crossref !== false,
  };

  const promises: Promise<LiteratureResult[]>[] = [];

  if (enabledSources.arxiv) promises.push(searchArxiv(query, maxPerSource).catch(() => []));
  if (enabledSources.semanticScholar) promises.push(searchSemanticScholar(query, maxPerSource, options.semanticScholarApiKey).catch(() => []));
  if (enabledSources.springer) promises.push(searchSpringer(query, maxPerSource, options.springerApiKey).catch(() => []));
  if (enabledSources.pubmed) promises.push(searchPubMed(query, maxPerSource).catch(() => []));
  if (enabledSources.crossref) promises.push(searchCrossRef(query, maxPerSource).catch(() => []));

  const allResults = (await Promise.all(promises)).flat();

  // ─── Validation layer: filter out low-quality and hallucinated references ───
  const currentYear = new Date().getFullYear();
  const validatedResults = allResults.filter(r => {
    // 1. Remove entries with empty or very short titles
    if (!r.title || r.title.trim().length < 5) return false;

    // 2. Remove entries with future publication years (hallucination indicator)
    if (r.year !== null && r.year > currentYear) return false;

    // 3. Remove entries with unreasonably old years (before 1900)
    if (r.year !== null && r.year < 1900) return false;

    // 4. Remove entries with no authors
    if (!r.authors || r.authors.trim().length === 0) return false;

    // 5. Remove entries where title looks auto-generated or placeholder
    const lowerTitle = r.title.toLowerCase();
    if (lowerTitle.includes("untitled") || lowerTitle.includes("test paper") ||
        lowerTitle.includes("placeholder") || lowerTitle.includes("lorem ipsum")) return false;

    return true;
  });

  const queryTerms = tokenizeQuery(query);
  const seen = new Map<string, { paper: LiteratureResult; score: number }>();
  for (const r of validatedResults) {
    const key = buildDedupKey(r);
    const score = scoreResultRelevance(r, queryTerms);
    if (!seen.has(key)) {
      seen.set(key, { paper: r, score });
    } else {
      const existing = seen.get(key)!;
      const resolved = pickBetterResult(existing.paper, r, existing.score, score);
      seen.set(key, { paper: resolved.best, score: resolved.score });
    }
  }

  const sorted = Array.from(seen.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((b.paper.citationCount || 0) !== (a.paper.citationCount || 0)) {
        return (b.paper.citationCount || 0) - (a.paper.citationCount || 0);
      }
      return (b.paper.year || 0) - (a.paper.year || 0);
    });

  // Apply minimum relevance threshold: require at least 1 query term match
  // (score of ~4.0 from title match or ~1.5 from abstract match).
  // Papers below threshold are likely irrelevant noise from broad keyword matches.
  const MIN_RELEVANCE_SCORE = 2.0;
  const filtered = sorted.filter(entry => entry.score >= MIN_RELEVANCE_SCORE);

  // If aggressive filtering removed too many papers, fall back to top results by score
  const finalResults = filtered.length >= 5 ? filtered : sorted.slice(0, Math.max(sorted.length, 5));

  return finalResults.map((entry) => entry.paper);
}
