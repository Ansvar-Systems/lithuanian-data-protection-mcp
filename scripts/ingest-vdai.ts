#!/usr/bin/env tsx
/**
 * VDAI (Valstybinė duomenų apsaugos inspekcija) ingestion crawler.
 *
 * Crawls the Lithuanian Data Protection Authority website (vdai.lrv.lt)
 * for enforcement decisions and guidance documents.
 *
 * Data sources:
 *   - Decisions:  https://vdai.lrv.lt/lt/sprendimai/         (year-based listing)
 *   - News:       https://vdai.lrv.lt/lt/naujienos/           (decision announcements)
 *   - Guidelines: https://vdai.lrv.lt/lt/veiklos-sritys-1/    (recommendations, guides)
 *
 * Usage:
 *   npx tsx scripts/ingest-vdai.ts
 *   npx tsx scripts/ingest-vdai.ts --resume          # skip already-ingested references
 *   npx tsx scripts/ingest-vdai.ts --dry-run         # crawl only, do not write to DB
 *   npx tsx scripts/ingest-vdai.ts --force           # drop existing data and re-ingest
 *   npx tsx scripts/ingest-vdai.ts --year 2024       # single year only
 *   npx tsx scripts/ingest-vdai.ts --limit 10        # stop after N decisions
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["VDAI_DB_PATH"] ?? "data/vdai.db";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;

const BASE_URL = "https://vdai.lrv.lt";

/** Decision listing pages — year-based plus the pre-2025 archive. */
const DECISION_INDEX_URLS: string[] = [
  "/lt/sprendimai/2025/",
  "/lt/sprendimai/vdai-sprendimai-baudos-nurodymai-ir-kt/",
];

/** News listing (announcements of decisions with more detail). */
const NEWS_INDEX_URL = "/lt/naujienos/";

/** Guideline/recommendation source pages. */
const GUIDELINE_SOURCES: Array<{ url: string; type: string }> = [
  { url: "/lt/veiklos-sritys-1/rekomendacijos/", type: "recommendation" },
  { url: "/lt/veiklos-sritys-1/gaires/", type: "guide" },
  { url: "/lt/naudinga-informacija/", type: "guidance" },
];

const USER_AGENT =
  "Mozilla/5.0 (compatible; AnsvarBot/1.0; +https://ansvar.eu/bot; GDPR-research)";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  year: number | null;
  limit: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    resume: false,
    dryRun: false,
    force: false,
    year: null,
    limit: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--year" && args[i + 1]) {
      options.year = parseInt(args[++i]!, 10);
    } else if (arg === "--limit" && args[i + 1]) {
      options.limit = parseInt(args[++i]!, 10);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "lt,en;q=0.5",
        },
        redirect: "follow",
      });

      if (res.status === 429) {
        const waitMs = RETRY_BACKOFF_MS * attempt * 2;
        console.warn(`  Rate limited (429). Waiting ${waitMs}ms before retry ${attempt}/${retries}...`);
        await sleep(waitMs);
        continue;
      }

      if (res.status === 403) {
        console.warn(`  Access denied (403) for ${url}. Attempt ${attempt}/${retries}.`);
        if (attempt < retries) {
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        return null;
      }

      if (!res.ok) {
        console.warn(`  HTTP ${res.status} for ${url}. Attempt ${attempt}/${retries}.`);
        if (attempt < retries) {
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        return null;
      }

      return await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Fetch error for ${url}: ${msg}. Attempt ${attempt}/${retries}.`);
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  return null;
}

/**
 * Fetch a PDF from a URL and extract readable text.
 * Falls back to returning null if the PDF cannot be processed.
 */
async function fetchPdfText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/pdf,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    // PDF text extraction requires external tooling. For now, return null
    // and rely on the HTML summary/announcement text instead.
    // Future: use pdf-parse or pdfjs-dist.
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8222;/g, "„")
    .replace(/&#8220;/g, "\u201C")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDate(raw: string): string | null {
  // Match YYYY-MM-DD
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0]!;

  // Match DD-MM-YYYY or DD.MM.YYYY or DD/MM/YYYY
  const eu = raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (eu) {
    const [, d, m, y] = eu;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // Match "YYYY m. MMMM DD d." Lithuanian date format
  const ltLong = raw.match(/(\d{4})\s+m\.\s+(\S+)\s+(\d{1,2})\s+d\./);
  if (ltLong) {
    const [, y, monthName, d] = ltLong;
    const month = ltMonthToNumber(monthName!);
    if (month) return `${y}-${month}-${d!.padStart(2, "0")}`;
  }

  return null;
}

function ltMonthToNumber(name: string): string | null {
  const months: Record<string, string> = {
    sausio: "01", vasario: "02", kovo: "03", balandžio: "04",
    gegužės: "05", birželio: "06", liepos: "07", rugpjūčio: "08",
    rugsėjo: "09", spalio: "10", lapkričio: "11", gruodžio: "12",
  };
  return months[name.toLowerCase()] ?? null;
}

/**
 * Extract a VDAI reference number (e.g. "3R-741 (2.13-1.E)") from text.
 */
function extractReference(text: string): string | null {
  const match = text.match(
    /(?:Nr\.\s*)?(\d+[A-Z]?R?-\d+(?:\s*\([^)]+\))?)/i,
  );
  return match ? match[1]!.trim() : null;
}

/**
 * Try to extract a fine amount in EUR from text.
 */
function extractFineAmount(text: string): number | null {
  // Match patterns like "15 000 EUR", "2 385 276 EUR", "15000 Eur"
  const match = text.match(
    /(\d[\d\s.,]*\d)\s*(?:EUR|Eur|eurų|euro)/i,
  );
  if (!match) return null;

  const raw = match[1]!.replace(/[\s.]/g, "").replace(",", ".");
  const amount = parseFloat(raw);
  return isNaN(amount) ? null : amount;
}

/**
 * Extract GDPR article references from text.
 * Looks for patterns like "BDAR 5 str.", "6(1)(f) str.", "33 straipsnio".
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // Pattern: "BDAR N str." or "BDAR N straipsnio" etc.
  const bdarMatches = text.matchAll(
    /BDAR\s+(\d+)(?:\s*\(\d+\))*(?:\s*(?:str\.|straipsn))/gi,
  );
  for (const m of bdarMatches) {
    articles.add(m[1]!);
  }

  // Pattern: "N straipsnio" / "N str." standalone
  const strMatches = text.matchAll(
    /(\d+)\s*(?:\(\d+\)(?:\([a-z]\))?)*\s*(?:str\b|straipsn)/gi,
  );
  for (const m of strMatches) {
    articles.add(m[1]!);
  }

  // Pattern: "Article N" (English)
  const enMatches = text.matchAll(/Article\s+(\d+)/gi);
  for (const m of enMatches) {
    articles.add(m[1]!);
  }

  return [...articles].sort((a, b) => parseInt(a) - parseInt(b));
}

/**
 * Infer the decision type from Lithuanian text.
 */
function classifyDecisionType(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("baudą") || lower.includes("bauda") || lower.includes("fine")) {
    return "sanction";
  }
  if (lower.includes("įspėjim") || lower.includes("warning")) {
    return "warning";
  }
  if (lower.includes("papeikimas") || lower.includes("reprimand")) {
    return "reprimand";
  }
  if (lower.includes("nurodym") || lower.includes("order") || lower.includes("įpareigoj")) {
    return "order";
  }
  if (lower.includes("nutrauk") || lower.includes("dismiss")) {
    return "dismissal";
  }
  return "decision";
}

/**
 * Map topics from text content using keyword matching.
 */
function inferTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const topics: string[] = [];

  const topicKeywords: Record<string, string[]> = {
    cookies: ["slapuk", "cookie", "sekikl", "tracker"],
    employee_monitoring: ["darbuotoj", "stebėjim", "employee", "monitoring", "darboviet"],
    video_surveillance: ["vaizdo stebėjim", "video", "kamer", "surveillance", "cctv"],
    data_breach: ["saugumo pažeidim", "duomenų pažeidim", "breach", "incidentas", "nutekėjim"],
    consent: ["sutikimas", "sutikimo", "consent", "rinkodar", "marketing"],
    dpia: ["poveikio vertinimas", "pdav", "dpia", "impact assessment"],
    transfers: ["perdavim", "trečiąsias šalis", "transfer", "tarptautin"],
    data_subject_rights: [
      "subjektų teisės", "prieigos teisė", "ištaisym", "ištrynim",
      "access right", "erasure", "portability", "data subject",
    ],
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      topics.push(topic);
    }
  }

  return topics.length > 0 ? topics : ["general"];
}

// ---------------------------------------------------------------------------
// Crawled data types
// ---------------------------------------------------------------------------

interface CrawledDecision {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string[];
  gdpr_articles: string[];
  source_url: string;
}

interface CrawledGuideline {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string;
  full_text: string;
  topics: string[];
  source_url: string;
}

// ---------------------------------------------------------------------------
// Phase 1: Crawl decision index pages
// ---------------------------------------------------------------------------

async function crawlDecisionIndex(indexUrl: string): Promise<Array<{ url: string; title: string; date: string | null }>> {
  const entries: Array<{ url: string; title: string; date: string | null }> = [];
  const fullUrl = `${BASE_URL}${indexUrl}`;

  console.log(`\n  Fetching decision index: ${fullUrl}`);
  const html = await fetchWithRetry(fullUrl);
  if (!html) {
    console.warn(`  Could not fetch decision index at ${fullUrl}`);
    return entries;
  }

  const $ = cheerio.load(html);

  // The lrv.lt CMS typically renders content pages with article/section-based
  // layouts. Decision listings appear as link lists, tables, or content blocks
  // within the main content area.

  // Strategy 1: Look for tables with decision rows
  $("table tr").each((_i, tr) => {
    const $tr = $(tr);
    const link = $tr.find("a[href]").first();
    const href = link.attr("href");
    const title = link.text().trim() || $tr.text().trim();

    if (!href || !title) return;

    const resolvedUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    const dateText = $tr.find("td").first().text().trim();
    const date = normalizeDate(dateText);

    entries.push({ url: resolvedUrl, title: stripHtml(title), date });
  });

  // Strategy 2: Look for linked content items in list elements
  if (entries.length === 0) {
    $("ul li a, ol li a, .content-list a, .list-group a, .news-list a").each((_i, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      const title = $a.text().trim();
      if (!href || !title || title.length < 10) return;

      const resolvedUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      entries.push({ url: resolvedUrl, title: stripHtml(title), date: null });
    });
  }

  // Strategy 3: Look for linked blocks within the main content area
  if (entries.length === 0) {
    $(".page-content a, .main-content a, article a, .field-items a, .entry-content a").each((_i, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      const title = $a.text().trim();

      if (!href || !title || title.length < 10) return;
      // Filter for decision-like links (contain reference numbers or key terms)
      if (!/sprendim|nutarim|baudą|bauda|3R-|Nr\./i.test(title) && !href.includes("sprendim")) {
        return;
      }

      const resolvedUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      entries.push({ url: resolvedUrl, title: stripHtml(title), date: null });
    });
  }

  // Strategy 4: Scan for PDF links (decisions often published as PDFs)
  $('a[href$=".pdf"]').each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    const title = $a.text().trim();

    if (!href || !title) return;
    // Only include decision-related PDFs
    if (!/sprendim|3R-|Nr\./i.test(title) && !/sprendim|3R-/i.test(href)) return;

    const resolvedUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    // Avoid duplicates
    if (!entries.some((e) => e.url === resolvedUrl)) {
      entries.push({ url: resolvedUrl, title: stripHtml(title), date: null });
    }
  });

  console.log(`  Found ${entries.length} decision entries`);
  return entries;
}

// ---------------------------------------------------------------------------
// Phase 2: Crawl individual decision pages
// ---------------------------------------------------------------------------

async function crawlDecisionPage(
  pageUrl: string,
  fallbackTitle: string,
  fallbackDate: string | null,
): Promise<CrawledDecision | null> {
  // If the URL is a PDF, we can only extract limited metadata from the URL itself
  if (pageUrl.endsWith(".pdf")) {
    return crawlDecisionPdf(pageUrl, fallbackTitle, fallbackDate);
  }

  const html = await fetchWithRetry(pageUrl);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Extract the main content area
  const contentSelectors = [
    ".page-content", ".main-content", "article", ".field-items",
    ".entry-content", ".content", "#content", "main",
  ];

  let mainContent = "";
  for (const sel of contentSelectors) {
    const block = $(sel).first();
    if (block.length > 0 && block.text().trim().length > 100) {
      mainContent = block.html() ?? "";
      break;
    }
  }

  if (!mainContent) {
    mainContent = $("body").html() ?? "";
  }

  const fullText = stripHtml(mainContent);
  if (fullText.length < 50) return null;

  // Extract title
  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim().replace(/\s*[-|].*$/, "") ||
    fallbackTitle;

  // Extract date
  const dateEl =
    $("time").attr("datetime") ??
    $(".date, .entry-date, .post-date, .published").first().text().trim() ??
    "";
  const date = normalizeDate(dateEl) ?? fallbackDate ?? extractDateFromText(fullText);

  // Extract reference number
  const reference = extractReference(fullText) ?? generateReference(title, date);

  // Extract entity name from title or content
  const entityName = extractEntityName(fullText, title);

  // Extract fine amount
  const fineAmount = extractFineAmount(fullText);

  // Extract GDPR articles
  const gdprArticles = extractGdprArticles(fullText);

  // Classify decision type
  const type = classifyDecisionType(fullText);

  // Build summary (first ~500 chars of meaningful content)
  const summary = buildSummary(fullText);

  // Infer topics
  const topics = inferTopics(fullText);

  return {
    reference,
    title: stripHtml(title),
    date,
    type,
    entity_name: entityName,
    fine_amount: fineAmount,
    summary,
    full_text: fullText,
    topics,
    gdpr_articles: gdprArticles,
    source_url: pageUrl,
  };
}

/**
 * Extract limited metadata from a decision PDF URL.
 * PDF URL pattern: /public/canonical/{id}/{id}/{date} sprendimas Nr. {ref} ({code}).pdf
 */
function crawlDecisionPdf(
  pdfUrl: string,
  fallbackTitle: string,
  fallbackDate: string | null,
): CrawledDecision | null {
  // Try to extract metadata from the URL itself
  const decoded = decodeURIComponent(pdfUrl);

  const dateMatch = decoded.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1]! : fallbackDate;

  const refMatch = decoded.match(/Nr\.\s*(\d*R?-\d+(?:\s*\([^)]+\))?)/i);
  const reference = refMatch
    ? refMatch[1]!.trim()
    : extractReference(fallbackTitle) ?? generateReference(fallbackTitle, date);

  return {
    reference,
    title: fallbackTitle || `VDAI sprendimas ${reference}`,
    date: date ?? null,
    type: "decision",
    entity_name: null,
    fine_amount: null,
    summary: `VDAI sprendimas Nr. ${reference}. Pilnas tekstas: ${pdfUrl}`,
    full_text: `VDAI sprendimas Nr. ${reference}. Dokumentas prieinamas PDF formatu: ${pdfUrl}`,
    topics: ["general"],
    gdpr_articles: [],
    source_url: pdfUrl,
  };
}

function generateReference(title: string, date: string | null): string {
  // Generate a deterministic reference from title and date
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9ąčęėįšųūž]+/gi, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `VDAI-${date ?? "undated"}-${slug}`;
}

function extractEntityName(text: string, title: string): string | null {
  // Look for entity names in common patterns
  const patterns = [
    /(?:bendrovei|bendrovė|įmonei|įmonė|UAB|AB|VšĮ|VĮ)\s+[„"]([^""]+)[""]/i,
    /(?:skirta|skyrė).*?(?:bendrovei|įmonei)\s+[„"]([^""]+)[""]/i,
    /([A-ZĄČĘĖĮŠŲŪŽ][A-Za-ząčęėįšųūž\s]+(?:UAB|AB|VšĮ|VĮ))/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern) ?? title.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function extractDateFromText(text: string): string | null {
  // Try to find a date in the first 500 chars of content
  const chunk = text.slice(0, 500);
  return normalizeDate(chunk);
}

function buildSummary(fullText: string): string {
  // Take first meaningful paragraph (skip short fragments)
  const sentences = fullText.split(/[.!]\s+/);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length > 500) break;
    if (sentence.length < 20) continue;
    summary += sentence.trim() + ". ";
  }
  return summary.trim().slice(0, 800);
}

// ---------------------------------------------------------------------------
// Phase 3: Crawl news pages for decision announcements
// ---------------------------------------------------------------------------

async function crawlNewsIndex(
  maxPages: number,
): Promise<Array<{ url: string; title: string; date: string | null }>> {
  const entries: Array<{ url: string; title: string; date: string | null }> = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl =
      page === 1
        ? `${BASE_URL}${NEWS_INDEX_URL}`
        : `${BASE_URL}${NEWS_INDEX_URL}?page=${page}`;

    console.log(`  Fetching news page ${page}: ${pageUrl}`);
    const html = await fetchWithRetry(pageUrl);
    if (!html) break;

    const $ = cheerio.load(html);
    let foundOnPage = 0;

    // News items are typically listed with titles + dates
    $("a[href]").each((_i, el) => {
      const $a = $(el);
      const href = $a.attr("href") ?? "";
      const title = $a.text().trim();

      // Only interested in news about decisions, fines, sanctions
      if (!href.includes("/naujienos/") && !href.includes("/news/")) return;
      if (title.length < 15) return;

      // Filter for decision-related news
      const combined = (title + " " + href).toLowerCase();
      const isDecisionRelated =
        /bauda|baudą|sprendim|pažeidim|sankcij|nurody|tikrin|skundą|bdar|gdpr|duomenų apsaug/i.test(
          combined,
        );
      if (!isDecisionRelated) return;

      const resolvedUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      // Avoid duplicates
      if (entries.some((e) => e.url === resolvedUrl)) return;

      entries.push({ url: resolvedUrl, title: stripHtml(title), date: null });
      foundOnPage++;
    });

    console.log(`  Page ${page}: found ${foundOnPage} decision-related news items`);

    // Stop paginating if no items found
    if (foundOnPage === 0) break;

    await sleep(RATE_LIMIT_MS);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Phase 4: Crawl guideline pages
// ---------------------------------------------------------------------------

async function crawlGuidelineIndex(
  source: { url: string; type: string },
): Promise<Array<{ url: string; title: string; type: string }>> {
  const entries: Array<{ url: string; title: string; type: string }> = [];
  const fullUrl = `${BASE_URL}${source.url}`;

  console.log(`\n  Fetching guideline index: ${fullUrl}`);
  const html = await fetchWithRetry(fullUrl);
  if (!html) {
    console.warn(`  Could not fetch guideline index at ${fullUrl}`);
    return entries;
  }

  const $ = cheerio.load(html);

  // Scan for links to guideline documents (pages or PDFs)
  $("a[href]").each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href") ?? "";
    const title = $a.text().trim();

    if (!title || title.length < 10) return;

    // Look for guideline-related content
    const combined = (title + " " + href).toLowerCase();
    const isGuideline =
      /rekomendacij|gairės|gairių|vadovas|metodin|atmintinė|patarima|instrukcij|tvarka|nurody/i.test(
        combined,
      ) || href.endsWith(".pdf");

    if (!isGuideline) return;

    const resolvedUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    // Avoid duplicates
    if (entries.some((e) => e.url === resolvedUrl)) return;

    entries.push({ url: resolvedUrl, title: stripHtml(title), type: source.type });
  });

  console.log(`  Found ${entries.length} guideline entries`);
  return entries;
}

async function crawlGuidelinePage(
  pageUrl: string,
  fallbackTitle: string,
  type: string,
): Promise<CrawledGuideline | null> {
  if (pageUrl.endsWith(".pdf")) {
    // For PDF guidelines, store a reference with the URL
    return {
      reference: generateGuidelineReference(fallbackTitle),
      title: fallbackTitle,
      date: null,
      type,
      summary: `VDAI ${type}: ${fallbackTitle}. Dokumentas prieinamas PDF formatu.`,
      full_text: `${fallbackTitle}. Dokumentas prieinamas PDF formatu: ${pageUrl}`,
      topics: inferTopics(fallbackTitle),
      source_url: pageUrl,
    };
  }

  const html = await fetchWithRetry(pageUrl);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Extract content
  const contentSelectors = [
    ".page-content", ".main-content", "article", ".field-items",
    ".entry-content", ".content", "#content", "main",
  ];

  let mainContent = "";
  for (const sel of contentSelectors) {
    const block = $(sel).first();
    if (block.length > 0 && block.text().trim().length > 100) {
      mainContent = block.html() ?? "";
      break;
    }
  }

  if (!mainContent) {
    mainContent = $("body").html() ?? "";
  }

  const fullText = stripHtml(mainContent);
  if (fullText.length < 50) return null;

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim().replace(/\s*[-|].*$/, "") ||
    fallbackTitle;

  const dateEl =
    $("time").attr("datetime") ??
    $(".date, .entry-date, .post-date, .published").first().text().trim() ??
    "";
  const date = normalizeDate(dateEl) ?? extractDateFromText(fullText);

  const reference = generateGuidelineReference(title);
  const summary = buildSummary(fullText);
  const topics = inferTopics(fullText);

  return {
    reference,
    title: stripHtml(title),
    date,
    type,
    summary,
    full_text: fullText,
    topics,
    source_url: pageUrl,
  };
}

function generateGuidelineReference(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9ąčęėįšųūž]+/gi, "-")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `VDAI-G-${slug}`;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function getExistingReferences(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference FROM decisions")
    .all() as Array<{ reference: string }>;
  return new Set(rows.map((r) => r.reference));
}

function getExistingGuidelineRefs(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference FROM guidelines WHERE reference IS NOT NULL")
    .all() as Array<{ reference: string }>;
  return new Set(rows.map((r) => r.reference));
}

function insertDecision(db: Database.Database, d: CrawledDecision): void {
  db.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final')
  `).run(
    d.reference,
    d.title,
    d.date,
    d.type,
    d.entity_name,
    d.fine_amount,
    d.summary,
    d.full_text,
    JSON.stringify(d.topics),
    JSON.stringify(d.gdpr_articles),
  );
}

function insertGuideline(db: Database.Database, g: CrawledGuideline): void {
  db.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'lt')
  `).run(
    g.reference,
    g.title,
    g.date,
    g.type,
    g.summary,
    g.full_text,
    JSON.stringify(g.topics),
  );
}

function seedTopics(db: Database.Database): void {
  const topics = [
    { id: "cookies", name_local: "Slapukai ir sekikliai", name_en: "Cookies and trackers", description: "Slapukų ir kitų sekiklių naudojimas galutinių vartotojų įrenginiuose." },
    { id: "employee_monitoring", name_local: "Darbuotojų stebėjimas", name_en: "Employee monitoring", description: "Darbuotojų duomenų tvarkymas ir stebėjimas darbo vietoje." },
    { id: "video_surveillance", name_local: "Vaizdo stebėjimas", name_en: "Video surveillance", description: "Vaizdo stebėjimo sistemų naudojimas ir asmens duomenų apsauga." },
    { id: "data_breach", name_local: "Duomenų saugumo pažeidimai", name_en: "Data breach notification", description: "Pranešimas apie asmens duomenų saugumo pažeidimus VDAI ir duomenų subjektams (BDAR 33–34 str.)." },
    { id: "consent", name_local: "Sutikimas", name_en: "Consent", description: "Sutikimo su asmens duomenų tvarkymu gavimas, galiojimas ir atšaukimas (BDAR 7 str.)." },
    { id: "dpia", name_local: "Poveikio duomenų apsaugai vertinimas", name_en: "Data Protection Impact Assessment (DPIA)", description: "Poveikio duomenų apsaugai vertinimas aukštos rizikos tvarkymui (BDAR 35 str.)." },
    { id: "transfers", name_local: "Tarptautiniai duomenų perdavimai", name_en: "International data transfers", description: "Asmens duomenų perdavimas į trečiąsias šalis arba tarptautines organizacijas (BDAR 44–49 str.)." },
    { id: "data_subject_rights", name_local: "Duomenų subjektų teisės", name_en: "Data subject rights", description: "Prieigos, ištaisymo, ištrynimo ir kitų teisių įgyvendinimas (BDAR 15–22 str.)." },
    { id: "direct_marketing", name_local: "Tiesioginė rinkodara", name_en: "Direct marketing", description: "Asmens duomenų tvarkymas tiesioginės rinkodaros tikslais." },
    { id: "children", name_local: "Vaikų duomenys", name_en: "Children's data", description: "Vaikų ir nepilnamečių asmens duomenų apsauga." },
    { id: "biometric_data", name_local: "Biometriniai duomenys", name_en: "Biometric data", description: "Biometrinių duomenų (pirštų atspaudai, veido atpažinimas) tvarkymas." },
    { id: "health_data", name_local: "Sveikatos duomenys", name_en: "Health data", description: "Specialių kategorijų sveikatos duomenų tvarkymas." },
    { id: "general", name_local: "Bendra duomenų apsauga", name_en: "General data protection", description: "Bendri asmens duomenų apsaugos klausimai." },
  ];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const insertAll = db.transaction(() => {
    for (const t of topics) {
      insert.run(t.id, t.name_local, t.name_en, t.description);
    }
  });

  insertAll();
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log("=== VDAI Ingestion Crawler ===");
  console.log(`  Database:  ${DB_PATH}`);
  console.log(`  Resume:    ${opts.resume}`);
  console.log(`  Dry run:   ${opts.dryRun}`);
  console.log(`  Force:     ${opts.force}`);
  console.log(`  Year:      ${opts.year ?? "all"}`);
  console.log(`  Limit:     ${opts.limit || "unlimited"}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms`);
  console.log();

  // --- Init DB ---

  const db = opts.dryRun ? null : initDb(opts.force);

  if (db) {
    seedTopics(db);
    console.log("Topics seeded.\n");
  }

  const existingRefs = db && opts.resume ? getExistingReferences(db) : new Set<string>();
  const existingGuidelineRefs =
    db && opts.resume ? getExistingGuidelineRefs(db) : new Set<string>();

  if (opts.resume) {
    console.log(`  Resuming: ${existingRefs.size} decisions, ${existingGuidelineRefs.size} guidelines already in DB.\n`);
  }

  // --- Phase 1: Collect decision URLs from index pages ---

  console.log("=== Phase 1: Decision Index Crawl ===");

  let decisionIndexUrls = DECISION_INDEX_URLS;
  if (opts.year) {
    decisionIndexUrls = [`/lt/sprendimai/${opts.year}/`];
  }

  // Also generate year-based URLs for 2018–2024
  if (!opts.year) {
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= 2018; y--) {
      const yearUrl = `/lt/sprendimai/${y}/`;
      if (!decisionIndexUrls.includes(yearUrl)) {
        decisionIndexUrls.push(yearUrl);
      }
    }
  }

  const allDecisionEntries: Array<{ url: string; title: string; date: string | null }> = [];
  const seenUrls = new Set<string>();

  for (const indexUrl of decisionIndexUrls) {
    const entries = await crawlDecisionIndex(indexUrl);
    for (const entry of entries) {
      if (!seenUrls.has(entry.url)) {
        seenUrls.add(entry.url);
        allDecisionEntries.push(entry);
      }
    }
    await sleep(RATE_LIMIT_MS);
  }

  // --- Phase 2: Crawl news for additional decision announcements ---

  console.log("\n=== Phase 2: News Crawl (decision announcements) ===");

  const newsEntries = await crawlNewsIndex(10); // max 10 pages of news
  for (const entry of newsEntries) {
    if (!seenUrls.has(entry.url)) {
      seenUrls.add(entry.url);
      allDecisionEntries.push(entry);
    }
  }

  console.log(`\nTotal unique decision URLs collected: ${allDecisionEntries.length}`);

  // Apply limit
  const limitedEntries =
    opts.limit > 0
      ? allDecisionEntries.slice(0, opts.limit)
      : allDecisionEntries;

  // --- Phase 3: Crawl individual decision pages ---

  console.log("\n=== Phase 3: Decision Detail Crawl ===");

  let decisionsIngested = 0;
  let decisionsSkipped = 0;
  let decisionsFailed = 0;

  for (let i = 0; i < limitedEntries.length; i++) {
    const entry = limitedEntries[i]!;
    const progress = `[${i + 1}/${limitedEntries.length}]`;

    // Try to extract reference early for resume check
    const earlyRef = extractReference(entry.title);
    if (opts.resume && earlyRef && existingRefs.has(earlyRef)) {
      console.log(`  ${progress} SKIP (resume): ${earlyRef}`);
      decisionsSkipped++;
      continue;
    }

    console.log(`  ${progress} Crawling: ${entry.title.slice(0, 80)}...`);
    console.log(`           URL: ${entry.url}`);

    const decision = await crawlDecisionPage(entry.url, entry.title, entry.date);

    if (!decision) {
      console.warn(`  ${progress} FAILED: could not parse decision page`);
      decisionsFailed++;
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Check resume against parsed reference
    if (opts.resume && existingRefs.has(decision.reference)) {
      console.log(`  ${progress} SKIP (resume): ${decision.reference}`);
      decisionsSkipped++;
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (opts.dryRun) {
      console.log(`  ${progress} DRY RUN: ${decision.reference}`);
      console.log(`           Title:  ${decision.title.slice(0, 60)}`);
      console.log(`           Date:   ${decision.date ?? "unknown"}`);
      console.log(`           Type:   ${decision.type}`);
      console.log(`           Fine:   ${decision.fine_amount ? `€${decision.fine_amount.toLocaleString()}` : "none"}`);
      console.log(`           GDPR:   ${decision.gdpr_articles.join(", ") || "none"}`);
      console.log(`           Topics: ${decision.topics.join(", ")}`);
    } else if (db) {
      insertDecision(db, decision);
      console.log(`  ${progress} OK: ${decision.reference} (${decision.type}, ${decision.date ?? "undated"})`);
    }

    decisionsIngested++;
    await sleep(RATE_LIMIT_MS);
  }

  // --- Phase 4: Crawl guidelines ---

  console.log("\n=== Phase 4: Guideline Crawl ===");

  const allGuidelineEntries: Array<{ url: string; title: string; type: string }> = [];
  const seenGuidelineUrls = new Set<string>();

  for (const source of GUIDELINE_SOURCES) {
    const entries = await crawlGuidelineIndex(source);
    for (const entry of entries) {
      if (!seenGuidelineUrls.has(entry.url)) {
        seenGuidelineUrls.add(entry.url);
        allGuidelineEntries.push(entry);
      }
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nTotal unique guideline URLs: ${allGuidelineEntries.length}`);

  let guidelinesIngested = 0;
  let guidelinesSkipped = 0;
  let guidelinesFailed = 0;

  for (let i = 0; i < allGuidelineEntries.length; i++) {
    const entry = allGuidelineEntries[i]!;
    const progress = `[${i + 1}/${allGuidelineEntries.length}]`;

    const earlyRef = generateGuidelineReference(entry.title);
    if (opts.resume && existingGuidelineRefs.has(earlyRef)) {
      console.log(`  ${progress} SKIP (resume): ${earlyRef}`);
      guidelinesSkipped++;
      continue;
    }

    console.log(`  ${progress} Crawling guideline: ${entry.title.slice(0, 70)}...`);

    const guideline = await crawlGuidelinePage(entry.url, entry.title, entry.type);

    if (!guideline) {
      console.warn(`  ${progress} FAILED: could not parse guideline page`);
      guidelinesFailed++;
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (opts.resume && guideline.reference && existingGuidelineRefs.has(guideline.reference)) {
      console.log(`  ${progress} SKIP (resume): ${guideline.reference}`);
      guidelinesSkipped++;
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (opts.dryRun) {
      console.log(`  ${progress} DRY RUN: ${guideline.reference}`);
      console.log(`           Title: ${guideline.title.slice(0, 60)}`);
      console.log(`           Date:  ${guideline.date ?? "unknown"}`);
      console.log(`           Type:  ${guideline.type}`);
    } else if (db) {
      insertGuideline(db, guideline);
      console.log(`  ${progress} OK: ${guideline.reference}`);
    }

    guidelinesIngested++;
    await sleep(RATE_LIMIT_MS);
  }

  // --- Summary ---

  console.log("\n=== Ingestion Summary ===");
  console.log(`  Decisions:  ${decisionsIngested} ingested, ${decisionsSkipped} skipped, ${decisionsFailed} failed`);
  console.log(`  Guidelines: ${guidelinesIngested} ingested, ${guidelinesSkipped} skipped, ${guidelinesFailed} failed`);

  if (db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
    ).cnt;
    const topicCount = (
      db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
    ).cnt;

    console.log(`\n  Database totals:`);
    console.log(`    Topics:     ${topicCount}`);
    console.log(`    Decisions:  ${decisionCount}`);
    console.log(`    Guidelines: ${guidelineCount}`);
    console.log(`\n  Database: ${DB_PATH}`);

    db.close();
  }

  if (opts.dryRun) {
    console.log("\n  (dry run — no data written to database)");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
