# 33. SEO and AI Discovery

Apply this chapter when code serves public web pages, routes, redirects, status codes, rendering, metadata, structured data, sitemaps, `robots.txt`, crawler/CDN/WAF rules, product or business feeds, or search and AI-referral analytics. Research basis: Google, Bing, DuckDuckGo, OpenAI, Perplexity, Anthropic, and Brave documentation, RFC 9309, the PageRank patent, and GEO research (KDD 2024, NeurIPS 2025, ICLR 2026, KDD 2026, Findings ACL 2026), checked 28 October 2026. Provider controls and reports change; verify current documentation before treating a detail below as a contract.

SEO and AI discovery share one foundation: useful, verifiable information that systems can reliably access, identify, and interpret. Generative answers add query expansion, evidence selection, synthesis, and citation, which are only partly disclosed. No public evidence establishes wording, schema, or "LLM optimization" tricks that guarantee citations or recommendations.

Work order: remove access and identity failures (P0); then relevance, evidence, and legitimate reputation (P1); then supported metadata and integrations; then measurement; only then test incremental GEO changes (P2). Agent-specific formats are optional (P3). An observed concrete failure moves a factor up.

Sections 33.1–33.10 state checks and practices; prohibitions live only in 33.11.

## 33.1 Keep stages and outcomes separate

A site can succeed at one stage and fail at the next.

| Stage | Measure |
| --- | --- |
| Discovery (links, sitemaps, feeds, notifications) | Known URLs, discovery delay |
| Access and rendering | Verified crawler requests, status codes, delivered and rendered content |
| Indexing and consolidation | Indexed canonical URLs, exclusion reasons, engine-selected canonicals |
| Retrieval and ranking | Impressions, clicks, CTR, position by segment |
| Answer construction and citation | Citation incidence, citation support, answer accuracy |
| Recommendation | Answers affirmatively recommending the entity |
| Business outcome | Qualified referrals, conversions |

- Training and retrieval are separate: a page update can change a future retrieval result without retraining, and a model can mention a brand from training without fetching the site.
- Retrieval queries differ from the user's prompt (documented query rewriting and fan-out). Pages are matched against supporting sub-questions, not only the original wording.
- Citation, support, and influence are separate. A page can be cited for a fact while the answer recommends a competitor.

## 33.2 Platforms and crawler roles

| Platform | Discovery basis | Consequence |
| --- | --- | --- |
| Google Search, AI Overviews, AI Mode | Search index, core ranking, query fan-out | Search eligibility is foundational; the Search Console generative AI control (worldwide since 31 August 2026) governs AI feature participation separately from ranking. |
| Bing, Microsoft Copilot | Bing index grounds web results and Copilot | Maintain Bing coverage; Bing-specific controls; use Bing AI citation reporting. |
| DuckDuckGo | Mostly Bing for links/images, plus own crawler and sources | Bing coverage matters; results are not identical. |
| ChatGPT Search | OpenAI crawler, search partners, query rewriting, user context | Allow `OAI-SearchBot`; evaluate the actual product and mode. |
| Perplexity | Own index plus partner search APIs | Test its retrieval directly; not a Bing wrapper. |
| Claude | Separate search, user-retrieval, and training agents | Configure each separately. |
| Brave Search | Own crawler; no distinct crawler UA; follows Googlebot restrictions | Check Brave separately; it honors Googlebot rules. |

| Token | Role |
| --- | --- |
| `Googlebot` | Google Search crawling, including Search AI access (smartphone and desktop share the token) |
| `Google-Extended` | Product-use token for training and specified Gemini/Vertex grounding; not an HTTP UA; does not control Search inclusion |
| `bingbot` | Bing index and grounding |
| `OAI-SearchBot` | ChatGPT Search discovery |
| `GPTBot` | Potential OpenAI foundation-model training |
| `ChatGPT-User` | User-triggered actions; not the Search crawler; robots rules may not apply |
| `PerplexityBot` | Perplexity search surfacing; not training |
| `Perplexity-User` | User-requested retrieval; generally ignores robots.txt |
| `ClaudeBot` | Potential Anthropic training |
| `Claude-SearchBot` / `Claude-User` | Search indexing / user-directed retrieval; both honor robots.txt |
| `DuckAssistBot` | DuckDuckGo AI answers; not training |

Search and training permissions are independent choices. Example separating them:

```
User-agent: *
Disallow:

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
```

- [ ] Each robots policy is a deliberate owner decision, not a copied block list.
- [ ] Effective groups tested per agent: a specific `User-agent` group does not inherit wildcard rules.
- [ ] `Google-Extended` decided separately; it also covers grounding outside Search.
- [ ] CDN/WAF exceptions use each provider's current verification method or published ranges, scoped to public access, with rate limits and logging.
- [ ] Blocking training does not remove already learned information; say so in any policy description.

## 33.3 Access, status codes, and rendering

- [ ] Public canonical pages return `200` with substantive content in production `GET` responses.
- [ ] Permanent moves use `301`/`308` to a relevant replacement; removed pages without replacement return `404`/`410`; temporary failures return an appropriate `5xx`/`429`.
- [ ] Principal facts, links, `<title>`, canonical, and robots meta are in the initial HTML (SSR or static generation); JavaScript progressively enhances. Renderers differ between clients.
- [ ] Mobile output carries the same substantive content and structured data as desktop (Google indexes mobile).
- [ ] Content is not gated behind clicks, login, or consent flows.
- [ ] Essential HTML stays well under Googlebot's fetch limits (2 MB uncompressed per non-PDF resource, 64 MB per PDF; referenced resources fetched separately). These are limits, not size targets.
- [ ] Private content is protected by authentication.

Verify by comparing raw HTML, no-JavaScript extraction, and rendered DOM on mobile and desktop, plus URL Inspection and real crawler logs (status, host, route, bytes, timing).

## 33.4 Indexing and display controls

- `robots.txt` controls cooperative crawling only. A crawler that cannot fetch a page cannot read its `noindex`, and a known blocked URL can stay indexed from external signals.
- To remove a public page from search: keep it crawlable and serve `noindex`. For PDFs and non-HTML resources use the `X-Robots-Tag` header.
- `nosnippet`, `max-snippet`, and `data-nosnippet` limit presentation and specified Search AI uses; they are not training opt-outs. `max-snippet` is a character limit with documented exceptions. `data-nosnippet` works only on `span`, `div`, or `section`; any value, including `"false"`, counts as present.
- Google ignores `noarchive` and `nocache`; Bing gives them Copilot meaning. Bing text under `data-nosnippet` can still be indexed and ranked.
- Keep pages intended for Google AI features snippet-eligible and included via the Search Console control.

- [ ] Audit the effective policy on the deployed response per URL and agent, including CDN-added headers.

## 33.5 URL identity: canonicals, links, crawl space, sitemaps, locales

Canonicals and redirects

- [ ] Each primary page has an absolute self-canonical; true duplicates point to their matching primary.
- [ ] Canonicals, redirects, internal links, sitemap entries, and hreflang all name the same URL.
- [ ] Canonical targets are crawlable, indexable, and exist.
- [ ] Distinct products, pagination pages, and translations keep their own canonicals.
- [ ] Migrations map each old URL to its specific replacement.

Internal links

- [ ] Navigation uses standard `<a href>` links with descriptive anchors, breadcrumbs, and linked pagination.
- [ ] No important page is orphaned or reachable only through a search form or infinite scroll.

Crawl space

- [ ] Stable routes and conventional parameters; no session IDs or timestamps in URLs.
- [ ] A deliberate facet policy: which filter combinations get indexable pages, which stay unlinked or non-indexable.
- [ ] Small, promptly crawled sites need no crawl-budget project.

Sitemaps and notifications

- [ ] List only intended canonical, indexable, `200` URLs.
- [ ] `lastmod` is the last significant content change from the content record, not build or deploy time. Google ignores `priority` and `changefreq`.
- [ ] Split oversized sitemap files.
- [ ] Send IndexNow notifications after a successful publish, update, or deletion only. Receipt is not indexing.

Language and region

- [ ] Substantive localized content, not translated navigation only.
- [ ] Reciprocal, self-including `hreflang` clusters with same-language self-canonicals; `x-default` only for a genuine fallback page.
- [ ] `<html lang>` set accurately (accessibility and clients; Google detects language from text).
- [ ] Users are not forced through geolocation redirects.

```html
<!-- English page; the Finnish page repeats the same alternates with its own self-canonical. -->
<link rel="canonical" href="https://example.com/en/runtime/">
<link rel="alternate" hreflang="en" href="https://example.com/en/runtime/">
<link rel="alternate" hreflang="fi" href="https://example.com/fi/kayttoaika/">
```

## 33.6 Metadata and structured data

Each field has its own job. Machine-readable does not mean consumed, and consumed does not mean ranked.

| Field | Documented purpose | Rule |
| --- | --- | --- |
| `<title>` | Google title links; Bing representation | Specific, accurate, distinct per page; length follows clarity |
| Meta description | Possible snippet source | Truthful summary; evaluate CTR separately from ranking |
| `h1`–`h6` | Structure; title-link input | Logical hierarchy |
| Open Graph | Google may use `og:title` and `og:image` | Consistent with visible content |
| Canonical | Representative URL preference | Absolute URL aligned with 33.5 |
| `robots` / `X-Robots-Tag` | Indexing and presentation controls | Audit on deployed response (33.4) |
| Organization / `sameAs` | Entity disambiguation | Genuine identifiers and equivalent profiles only |
| Article author/dates | Authorship and date understanding | Match visible byline and real dates; a person is `Person` |
| Product / Offer | Commerce features | Identical price, currency, stock, variants on page, JSON-LD, and feed |
| Business details | Local matching | Accurate hours, category, address, contact |
| Meta keywords | Ignored by Google | No effort |
| FAQPage | Vocabulary only; Google FAQ rich results retired 7 May 2026 | Use real questions if helpful; promise no rich result |

- MUST generate visible facts and JSON-LD from the same content record, server-side, in the initial HTML. This prevents contradictions and enables automated parity checks.
- MUST add only properties you can substantiate.
- SHOULD validate both schema syntax and supported-feature eligibility; they are separate checks, and eligibility does not guarantee display.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": "https://example.com/research/runtime-method/#article",
  "mainEntityOfPage": "https://example.com/research/runtime-method/",
  "headline": "Battery runtime test method",
  "inLanguage": "en",
  "datePublished": "2026-10-01",
  "dateModified": "2026-10-28",
  "author": { "@type": "Person", "name": "Alex Example", "url": "https://example.com/people/alex-example/" },
  "publisher": { "@type": "Organization", "@id": "https://example.com/#organization", "name": "Example Research", "url": "https://example.com/" }
}
</script>
```

## 33.7 Content that systems can retrieve and trust

Relevance is semantic (neural matching, passage ranking), not keyword repetition. A passage can match a query without its own URL.

| User need | Effective content |
| --- | --- |
| Definition | Explicit entity definition, boundary, example |
| Task | Requirements, ordered steps, expected result, failure handling |
| Comparison | Named alternatives, equal criteria, evidence, trade-offs |
| Recommendation | Fit by budget, use case, location, compatibility, limits |
| Current fact | Value with unit, scope, date/version, primary source |
| Multi-step research | One connected explanation of core questions, dependencies, uncertainties |

- SHOULD give each page one purpose, with the answer or scope statement early and substantiating detail after.
- SHOULD keep entity, conditions, units, version, scope, and limits in the same passage as the claim, so it survives extraction.
- SHOULD name the reader's task in headings; use tables for real comparisons and ordered lists for real sequences.
- SHOULD link primary evidence where the claim appears; separate observation, inference, and recommendation.
- SHOULD publish genuine methods, datasets, sample sizes, dates, and failure cases.
- SHOULD identify responsible authors or organizations: real bylines, author pages, review responsibility, correction history.
- SHOULD keep organization name, About page, contact details, product IDs, and `sameAs` profiles consistent across site, feeds, and profiles.
- SHOULD keep product feeds and business profiles synchronized with landing pages.
- SHOULD update volatile facts promptly, show version/review dates and validity periods for prices, retain dated archives linked to current guidance.
- SHOULD keep key facts in HTML text; give informative images functional alt text; caption tables and charts; provide transcripts.
- SHOULD write in the audience's language and test search and answers in that language.
- SHOULD earn editorial references through useful work; mark sponsored and user-generated links (`rel="sponsored"`, `rel="ugc"`).

Claims keep their evidence:

```
Weak:   Our revolutionary platform is the fastest, most trusted solution for every business.
Better: Example Scheduler imports iCalendar files and sends reminders in the account's selected
        time zone. It is intended for small teams managing recurring appointments. It does not
        include payroll functionality.

Quantitative template (fill only with real evidence):
Under [workload], [product/version] completed [operation] in [value + units], compared with
[baseline]. Testing used [method and sample] on [date]. [Limitations] apply.
```

## 33.8 Performance

- Core Web Vitals are Google ranking inputs; other page-experience aspects are not direct ranking inputs beyond them.
- Targets at field p75: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, segmented by template and device.
- Lighthouse diagnoses regressions; field data is the measure.
- Accessibility, security, and usability remain engineering requirements regardless of ranking effect.

## 33.9 CI validation

| Stage | Automate | Observe separately |
| --- | --- | --- |
| Build | Route manifest, titles, canonicals, index directives, JSON-LD parsing, content/schema parity, sitemap coverage, internal links | Usefulness, originality, truth |
| Preview | Raw vs rendered HTML, mobile parity, error/redirect routes, accessibility and performance budgets | Task completion by people |
| Deploy | Production `GET`: status, final URL, content type, headers, robots, body; sitemap/notification delivery | Genuine crawler access through CDN |
| Recurring | Native report exports, verified crawl logs, referral classification, regression alerts | Index selection, citation support, recommendations, business impact |

- Release blockers: accidental `noindex` on a public page, wrong canonical, missing principal content, invalid structured data, sitemap entries for nonexistent routes.
- Warnings: duplicate titles, stale revision dates, unexpectedly large payloads.
- A CI pass confirms its bounded checks, not public discoverability. Validators SHOULD reject robots constructs they cannot model rather than certify them.
- Search measurement uses permitted APIs and approved sampling, not automated scraping in CI.

## 33.10 Measurement and experiments

| Metric | Definition | Limit |
| --- | --- | --- |
| Crawl success | Verified crawler successful fetches / eligible attempts; count valid `304` separately | Fetch is not inclusion |
| Index coverage | Intended canonical URLs indexed, with exclusion reasons | `site:` is not an index census |
| Organic performance | Impressions, clicks, CTR, position by segment | Query mix distorts averages |
| Google AI visibility | Search Console generative AI impressions (page, country, device, date; Pacific Time dates) | Not clicks, CTR, or rankings; low volume hides data |
| Bing AI citations | Citations, cited URLs, trends, sampled grounding phrases | Not authority or placement |
| Citation incidence | Sampled answers citing target URL/domain / defined answer set | Keep unconditional and search-conditional denominators distinct |
| Recommendation incidence | Answers affirmatively recommending target / eligible decision prompts | A mention or criticism is not a recommendation |
| Citation support | Human-checked claim–citation pairs | Support is not causal influence |
| Referral and conversion | Observed referral/UTM visits and outcomes | Missing referrers, zero-click answers |

- Build AI referral rules from observed hosts and parameters (e.g. `chatgpt.com`, `perplexity.ai`) with an `unknown` bucket; UTM tags are not universal. Label last-touch attribution as such.
- Normalize time zones before joining datasets; keep URL-level and domain-level results separate; resolve redirects; count repeated links in one answer once.
- Report correlation units: URL or domain, query or family, ranking depth, date, country, language, device, product mode.

Experiment protocol for GEO changes:

1. One hypothesis, one primary outcome, a predefined minimum meaningful effect, stopping rule, and guardrails (organic acquisition, factual accuracy).
2. Randomize matched page/topic clusters to treatment and control; cluster when pages share queries or links. Hold URLs, core facts, and canonicals fixed.
3. Freeze the query panel before editing: paraphrases, informational, comparison, and recommendation intents.
4. Record environment: product, mode, UI vs API, locale, device, account and conversation state, timestamp, page revision. Unknown internals stay `null`.
5. Baseline, publish, observe recrawl. Keep every randomized unit in the analysis, reindexed or not.
6. Repeat across dates and paraphrases. Repeated outputs for one query are not independent units; roughly 700 observations per arm detect 10%→15% under simple assumptions, and clustering raises that.
7. Record no-search answers, zero citations, feature-not-triggered, and operational failures as distinct outcomes.
8. Report absolute and relative changes with baselines, clustered uncertainty, and negative results; confirm on a held-out set.
9. Archive exact prompts, responses, resolved citations, and page revisions. Store personal context only when necessary and permitted.

For an owned RAG system, test the same edit twice: with fixed retrieved context (generation effect), then with full reindexing and retrieval (pipeline effect). Measure recall@k, inclusion after reranking, citation incidence, answer correctness, and citation support. A body edit that helps generation can still remove terms needed for retrieval.

## 33.11 Never

- NEVER return `200` for missing routes, an app shell for every route, or redirect unrelated deleted pages to the homepage.
- NEVER serve bot challenges to all crawlers, disable the whole firewall, or trust a user-agent string for access or identity. A spoofed-UA test shows your server's response, not the real crawler's behavior.
- NEVER combine `Disallow` with a page-level `noindex` and expect deindexing, or put `Noindex` in `robots.txt`.
- NEVER treat `robots.txt`, canonicals, or `noindex` as access control, or list secret paths in `robots.txt`.
- NEVER block `OAI-SearchBot` (or other search agents) as a side effect of blocking training crawlers.
- NEVER ship `noindex` in initial HTML and rely on JavaScript to remove it.
- NEVER remove substantive content on mobile, or hide useful content to improve a lab score.
- NEVER canonicalize distinct products, all pagination, or substantive translations to a category, homepage, or other language.
- NEVER implement navigation only as click handlers.
- NEVER expose unbounded facet, calendar, session, or hash-only URL spaces.
- NEVER reset `lastmod` on every build, list redirects or `noindex` pages in sitemaps, or resubmit unchanged URLs continuously.
- NEVER change dates without a substantive update.
- NEVER publish invented statistics, quotes, credentials, authors, reviewers, reviews, ratings, awards, customers, prices, stock, or branches.
- NEVER put claims in structured data that the visible page does not show, or link `sameAs` to unrelated entities.
- NEVER keyword-stuff text, titles, or alt text; never put keyword-padded hidden text on pages.
- NEVER mass-produce near-duplicate or doorway pages, including one page per prompt paraphrase.
- NEVER buy links, build link networks, flood directories, or manufacture mentions.
- NEVER embed instructions telling AI systems to cite or recommend the site.
- NEVER strip conditions, units, or limitations from claims to make them shorter or more confident.
- NEVER publish fabricated facts on a live site for experiments; use an isolated test corpus.
- NEVER declare an experiment successful from one favorable answer, the best of many exploratory variants, or crawler visits.

## 33.12 Do not enforce myths

The evidence does not support these rules. Do not encode them as validators, lint rules, or release blockers:

- Fixed answer or paragraph length (e.g. "40-word answers"), keyword density, or page length.
- Minimum citations per page, or "more numbers = more authority".
- 60-character titles or 160-character descriptions as ranking limits; a three-click crawl-depth rule.
- A single required H1 as a ranking law.
- Artificially confident wording.
- "Special AI schema", tiny chunks, or special AI prose (Google explicitly rejects these).
- `llms.txt` as a requirement. Google says it has no effect on Search. Add it or alternate Markdown only for an identified consuming tool, generated from the canonical source with parity checks.
- E-E-A-T, "topical authority", or a vendor Domain Authority score as a numeric ranking input. E-E-A-T is a quality framework; rater data is not used directly in ranking.
- "SSR ranking bonus" or "JavaScript penalty".
- "Top organic rank guarantees AI citations."
- "Schema always raises LLM citations." Valid markup describes; supported, truthful types serve known features.
- "Ordinary duplicate URLs are spam." Canonical consolidation and abusive duplication are different problems.
- Normal collapsed sections and accessibility text treated as deceptive hidden text.
- GEO "up to 40%" results as promised traffic. Those experiments used preselected sources; broader benchmarks found many generic edits neutral or harmful.
