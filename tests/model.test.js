const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const Model = require("../Model.js")

// Fixtures are synthesized X API v2 envelopes (real v2 shapes; live capture
// waits on API credits, see docs/FIXTURES.md). They exercise the parse,
// classify, dedupe, score, digest, and spend paths offline. The conversation
// fixture is a realistic reply mix: two independent bug reports (one a
// near-duplicate), a feature ask, a question, praise, a "+1", and spam.
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")

const SELF = "44196397"
const NOW_MS = Date.parse("2026-08-20T16:00:00Z")

// ---- clean ----

test("clean strips angle brackets, controls, bidi, and tag chars", () => {
  assert.equal(Model.clean('<img src=x>hi'), "img src=xhi")
  assert.equal(Model.clean("a\x00b\x7fc"), "abc")
  assert.equal(Model.clean("a‮b⁦c", 10), "abc")
  assert.equal(Model.clean("x".repeat(80), 32).length, 32)
})

// ---- URL safety ----

test("threadUrl builds only from a clean handle and numeric id", () => {
  assert.equal(Model.threadUrl("testfounder", "123"), "https://x.com/testfounder/status/123")
  // Every non-handle character is stripped, so a metacharacter-laden value
  // can never reach the URL (and thus never reach xdg-open's argv).
  assert.equal(Model.threadUrl("bad; rm -rf", "123"), "https://x.com/badrmrf/status/123")
  assert.equal(Model.threadUrl("", "123"), "")
  assert.equal(Model.threadUrl("user", "12a3"), "https://x.com/user/status/123")
})

// ---- URL builders keep since_id discipline ----

test("URL builders carry since_id when given and omit it when not", () => {
  assert.ok(Model.userTweetsUrl("44196397", "").indexOf("since_id") === -1)
  assert.ok(Model.userTweetsUrl("44196397", "999").indexOf("since_id=999") > 0)
  assert.ok(Model.mentionsUrl("44196397", "999").indexOf("since_id=999") > 0)
  assert.ok(Model.conversationSearchUrl("1900000000000000001", "").indexOf("conversation_id") > 0)
  assert.ok(Model.userTweetsUrl("44196397").indexOf("max_results=25") > 0)
})

// ---- rate headers ----

test("parseRateHeaders reads the three x-rate-limit fields", () => {
  const r = Model.parseRateHeaders("HTTP/2 200\r\nx-rate-limit-limit: 450\r\nx-rate-limit-remaining: 12\r\nx-rate-limit-reset: 1787000000\r\n")
  assert.equal(r.limit, 450)
  assert.equal(r.remaining, 12)
  assert.equal(r.resetAt, 1787000000)
})

test("backoffMs prefers the reset time, else exponential capped at 30s", () => {
  assert.equal(Model.backoffMs(0, 0, NOW_MS), 1000)
  assert.equal(Model.backoffMs(10, 0, NOW_MS), 30000)
  const withReset = Model.backoffMs(0, Math.floor(NOW_MS / 1000) + 60, NOW_MS)
  assert.ok(withReset >= 60000 && withReset <= 62000)
})

// ---- response parsing ----

test("parseUserLookup extracts id, username, name", () => {
  const u = Model.parseUserLookup(fixture("user-lookup.json"))
  assert.equal(u.id, "44196397")
  assert.equal(u.username, "testfounder")
})

test("parseUserLookup rejects malformed bodies", () => {
  assert.equal(Model.parseUserLookup("{}"), null)
  assert.equal(Model.parseUserLookup("not json"), null)
})

test("parseTweetList joins author usernames from includes and counts results", () => {
  const parsed = Model.parseTweetList(fixture("conversation.json"))
  assert.equal(parsed.valid, true)
  assert.equal(parsed.resultCount, 7)
  assert.equal(parsed.tweets.length, 7)
  assert.equal(parsed.newestId, "1900000000000000107")
  const first = parsed.tweets[0]
  assert.equal(first.authorUsername, "wayland_user")
  assert.ok(first.metrics.likes >= 0)
})

test("parseTweetList returns the zero shape on malformed or oversized input", () => {
  assert.equal(Model.parseTweetList("nope").valid, false)
  assert.equal(Model.parseTweetList("x".repeat(Model.MAX_BODY_CHARS + 1)).valid, false)
})

// ---- classification ----

test("classifyReply buckets the reply mix correctly", () => {
  assert.equal(Model.classifyReply("This is broken for me, the panel crashes on open."), "gripe")
  assert.equal(Model.classifyReply("Could you add per-provider toggles?"), "feature_ask")
  assert.equal(Model.classifyReply("How does the spend meter know the price?"), "question")
  assert.equal(Model.classifyReply("love this, absolute gold"), "praise")
  assert.equal(Model.classifyReply("follow me for crypto signals, DM for the airdrop"), "noise")
  assert.equal(Model.classifyReply("same here"), "noise")
})

test("classifyReply reads sarcasm as a gripe, not praise", () => {
  assert.equal(Model.classifyReply("love how it crashes every single time /s"), "gripe")
})

test("a bug complaint that also says 'love' still classifies as a gripe", () => {
  assert.equal(Model.classifyReply("love the idea but it is completely broken and crashes"), "gripe")
})

// ---- substance ----

test("substanceScore floors '+1' chains and rewards specific reports", () => {
  assert.ok(Model.substanceScore("same here", {}) <= 0.1)
  assert.ok(Model.substanceScore("+1", {}) <= 0.1)
  assert.ok(Model.substanceScore(
    "The panel crashes on open on Wayland, version 1.0, every time I press super+r.",
    { likes: 6 }) > 0.5)
})

// ---- dedupe ----

test("the shipped default dedup threshold collapses the two crash reports", () => {
  // Guards the shipped-vs-tested divergence: production calls collapseDuplicates
  // with no threshold, so the DEFAULT must be the value that actually collapses
  // the fixture's near-duplicate pair.
  assert.equal(Model.DUP_THRESHOLD, 0.55)
  const parsed = Model.parseTweetList(fixture("conversation.json"))
  const replies = parsed.tweets
    .filter((t) => t.authorId !== SELF)
    .map((t) => ({ id: t.id, text: t.text, authorUsername: t.authorUsername,
      metrics: t.metrics, bucket: Model.classifyReply(t.text) }))
  Model.collapseDuplicates(replies) // no threshold: uses the shipped default
  const crashers = replies.filter((r) => /crash/i.test(r.text))
  assert.equal(crashers.filter((r) => r.isCanonical).length, 1, "default threshold collapses the pair")
  // Every clustered member shares the canonical's group id.
  assert.equal(crashers[0].groupId, crashers[1].groupId)
})

test("collapseDuplicates groups the two near-identical Wayland-crash reports", () => {
  const parsed = Model.parseTweetList(fixture("conversation.json"))
  const replies = parsed.tweets
    .filter((t) => t.authorId !== SELF)
    .map((t) => ({ id: t.id, text: t.text, authorUsername: t.authorUsername,
      metrics: t.metrics, bucket: Model.classifyReply(t.text) }))
  Model.collapseDuplicates(replies)
  const crashers = replies.filter((r) => /crash/i.test(r.text))
  assert.equal(crashers.length, 2)
  const canon = crashers.filter((r) => r.isCanonical)
  assert.equal(canon.length, 1, "one of the two crash reports is canonical")
  assert.ok(canon[0].dupCount >= 1)
})

test("hybridSimilarity is high for paraphrases and low for unrelated text", () => {
  assert.ok(Model.hybridSimilarity("the panel crashes on open", "panel crashes when I open it") > 0.4)
  assert.ok(Model.hybridSimilarity("the panel crashes", "please add dark mode") < 0.2)
})

// ---- redaction ----

test("redactPii strips emails, tokens, keys, and phones before any prompt", () => {
  const r = Model.redactPii("mail me at a@b.com or use sk-ABCDEFGHIJKLMNOPQRSTUVWX call 415-555-1212")
  assert.ok(r.redactedText.indexOf("a@b.com") === -1)
  assert.ok(r.redactedText.indexOf("sk-ABCDEFGHIJKLMNOPQRSTUVWX") === -1)
  assert.ok(r.redactedText.indexOf("415-555-1212") === -1)
  assert.ok(r.piiFlags.indexOf("email") >= 0)
})

// ---- digest ----

function ingestFixture() {
  const parsed = Model.parseTweetList(fixture("conversation.json"))
  const replies = parsed.tweets
    .filter((t) => t.authorId !== SELF)
    .map((t) => ({ id: t.id, text: t.text, authorId: t.authorId,
      authorUsername: t.authorUsername, conversationId: t.conversationId,
      createdMs: t.createdMs, metrics: t.metrics,
      bucket: Model.classifyReply(t.text),
      substance: Model.substanceScore(t.text, t.metrics) }))
  Model.collapseDuplicates(replies)
  return replies
}

test("bucketCounts and bucketChips summarize the reply mix", () => {
  const replies = ingestFixture()
  const counts = Model.bucketCounts(replies)
  assert.ok(counts.gripe >= 2)
  assert.ok(counts.feature_ask >= 1)
  assert.ok(counts.question >= 1)
  assert.ok(counts.praise >= 1)
  assert.ok(counts.noise >= 2)
  assert.ok(Model.bucketChips(counts).indexOf("gripe") >= 0)
})

test("bucketChips pluralizes per count and leaves mass nouns invariant", () => {
  assert.equal(Model.bucketChips({ gripe: 1, question: 1, feature_ask: 1, praise: 1, noise: 0 }),
    "1 gripe · 1 question · 1 ask · 1 praise")
  assert.equal(Model.bucketChips({ gripe: 4, question: 2, feature_ask: 1, praise: 0, noise: 0 }),
    "4 gripes · 2 questions · 1 ask")
})

test("topQuotes returns verbatim canonical quotes, never a numeric score", () => {
  const replies = ingestFixture()
  const quotes = Model.topQuotes(replies)
  assert.ok(quotes.length >= 1 && quotes.length <= 2)
  for (const q of quotes) {
    assert.ok(q.text.length > 0)
    assert.ok(q.bucket !== "noise")
    assert.equal(typeof q.username, "string")
  }
})

// ---- needs-reply gate ----

test("needsReply passes substantive questions/gripes/asks from others only", () => {
  const replies = ingestFixture()
  const queue = replies.filter((r) => Model.needsReply(r, SELF))
  const buckets = queue.map((r) => r.bucket)
  assert.ok(buckets.indexOf("gripe") >= 0)
  assert.ok(buckets.indexOf("feature_ask") >= 0 || buckets.indexOf("question") >= 0)
  assert.ok(queue.every((r) => r.bucket !== "praise" && r.bucket !== "noise"))
  // The "+1" and spam never reach the queue.
  assert.ok(!queue.some((r) => /same here/i.test(r.text)))
  assert.ok(!queue.some((r) => /crypto signals/i.test(r.text)))
  // Only one of the two duplicate crash reports (the canonical) is queued.
  assert.equal(queue.filter((r) => /crash/i.test(r.text)).length, 1)
})

test("needsReply excludes the author's own replies", () => {
  const self = { authorId: SELF, bucket: "question", substance: 0.9, isCanonical: true }
  assert.equal(Model.needsReply(self, SELF), false)
})

test("a terse gripe clears the queue via the lower gripe floor", () => {
  // "broken" scores at the gripe floor; a founder wants a two-word outage in
  // the queue. A question at the same substance stays below the higher floor.
  const griped = { authorId: "x", bucket: "gripe", substance: Model.GRIPE_FLOOR, isCanonical: true }
  const asked = { authorId: "x", bucket: "feature_ask", substance: Model.GRIPE_FLOOR, isCanonical: true }
  assert.equal(Model.needsReply(griped, SELF), true)
  assert.equal(Model.needsReply(asked, SELF), false)
  assert.ok(Model.GRIPE_FLOOR < Model.SUBSTANCE_FLOOR)
})

test("referenced_tweets exposes the replied-to parent for self-thread routing", () => {
  const body = JSON.stringify({
    data: [{ id: "2", text: "reply", created_at: "2026-08-20T10:00:00Z",
      conversation_id: "1", author_id: "9",
      referenced_tweets: [{ type: "replied_to", id: "1" }],
      public_metrics: {} }],
    meta: { result_count: 1, newest_id: "2" }
  })
  const parsed = Model.parseTweetList(body)
  assert.equal(parsed.tweets[0].replyParentId, "1")
  // No referenced_tweets -> empty, so routing falls back to conversation.
  const noRef = Model.parseTweetList(JSON.stringify({
    data: [{ id: "3", text: "t", created_at: "2026-08-20T10:00:00Z", conversation_id: "1", author_id: "9", public_metrics: {} }],
    meta: { result_count: 1 }
  }))
  assert.equal(noRef.tweets[0].replyParentId, "")
})

// ---- spend meter ----

test("chargeLedger accumulates within a month and resets across months", () => {
  let l = Model.chargeLedger(null, 100, 0.005, NOW_MS)
  assert.equal(l.posts, 100)
  assert.equal(l.dollars, 0.5)
  l = Model.chargeLedger(l, 50, 0.005, NOW_MS)
  assert.equal(l.posts, 150)
  assert.equal(l.dollars, 0.75)
  const nextMonth = Date.parse("2026-09-01T00:00:00Z")
  l = Model.chargeLedger(l, 10, 0.005, nextMonth)
  assert.equal(l.posts, 10, "ledger resets on a new month")
})

test("projectedMonthUsd extrapolates linearly on the month so far", () => {
  const midMonth = Date.parse("2026-08-10T00:00:00Z") // day 10 of 31
  const l = { month: "2026-08", posts: 200, dollars: 1.0 }
  const proj = Model.projectedMonthUsd(l, midMonth)
  assert.ok(proj > 3.0 && proj < 3.2, "1.00 by day 10 projects ~3.10 for August")
})

test("budgetStopped is a hard stop at the cap", () => {
  assert.equal(Model.budgetStopped({ month: "2026-08", dollars: 8.01, posts: 0 }, 8, NOW_MS), true)
  assert.equal(Model.budgetStopped({ month: "2026-08", dollars: 5, posts: 0 }, 8, NOW_MS), false)
  assert.equal(Model.budgetStopped({ month: "2026-07", dollars: 99, posts: 0 }, 8, NOW_MS), false)
})

test("budgetStopped has a price-independent read ceiling a low cost cannot hide", () => {
  // A near-zero costPerPost keeps dollars tiny, but the read count still trips
  // the ceiling derived from the cap at the floor price.
  const ceiling = Model.readCeiling(8)
  assert.equal(ceiling, Math.ceil(8 / Model.COST_FLOOR))
  assert.equal(Model.budgetStopped({ month: "2026-08", dollars: 0.01, posts: ceiling }, 8, NOW_MS), true)
  assert.equal(Model.budgetStopped({ month: "2026-08", dollars: 0.01, posts: ceiling - 1 }, 8, NOW_MS), false)
})

test("clampCost floors an implausibly low per-post price", () => {
  assert.equal(Model.clampCost(0.005), 0.005)
  assert.equal(Model.clampCost(0.0000001), Model.DEFAULT_COST_PER_POST)
  assert.equal(Model.clampCost(0), Model.DEFAULT_COST_PER_POST)
  assert.equal(Model.clampCost("nonsense"), Model.DEFAULT_COST_PER_POST)
})

test("spend-meter display modes gate the exact figure but never the cap", () => {
  const near = { month: "2026-08", posts: 0, dollars: 6.8 } // 85% of an 8 cap
  const low = { month: "2026-08", posts: 0, dollars: 1.0 }
  // Full always shows the line; Off/Compact never do; On alert only near cap.
  assert.equal(Model.showSpendLine("Full", low, 8, NOW_MS), true)
  assert.equal(Model.showSpendLine("Off", near, 8, NOW_MS), false)
  assert.equal(Model.showSpendLine("Compact", near, 8, NOW_MS), false)
  assert.equal(Model.showSpendLine("On alert", low, 8, NOW_MS), false)
  assert.equal(Model.showSpendLine("On alert", near, 8, NOW_MS), true)
  // spendMode normalizes unknown values to the calm default.
  assert.equal(Model.spendMode("Full"), "Full")
  assert.equal(Model.spendMode("nonsense"), "Compact")
  assert.equal(Model.spendMode(undefined), "Compact")
})

test("spendFraction is a clamped 0..1 of the cap", () => {
  assert.equal(Model.spendFraction({ month: "2026-08", dollars: 4 }, 8, NOW_MS), 0.5)
  assert.equal(Model.spendFraction({ month: "2026-08", dollars: 20 }, 8, NOW_MS), 1)
  assert.equal(Model.spendFraction({ month: "2026-07", dollars: 4 }, 8, NOW_MS), 0)
  assert.equal(Model.spendFraction(null, 8, NOW_MS), 0)
})

test("parseState carries a validated spendMeter mode", () => {
  assert.equal(Model.parseState(JSON.stringify({ configured: true, spendMeter: "Full", queue: [], posts: [] })).spendMeter, "Full")
  assert.equal(Model.parseState(JSON.stringify({ configured: true, spendMeter: "bogus", queue: [], posts: [] })).spendMeter, "Compact")
  assert.equal(Model.parseState(JSON.stringify({ configured: true, queue: [], posts: [] })).spendMeter, "Compact")
})

test("spendText and usd format money cleanly", () => {
  assert.equal(Model.usd(1.5), "$1.50")
  assert.equal(Model.usd(0), "$0.00")
  const t = Model.spendText({ month: "2026-08", posts: 0, dollars: 1.83 }, NOW_MS)
  assert.ok(t.indexOf("$1.83 this month") === 0)
  assert.ok(t.indexOf("projected") > 0)
})

// ---- pill ----

test("pillText reflects setup, paused, count, and drained states", () => {
  assert.equal(Model.pillText({ valid: true, configured: false }), "X Files: setup")
  assert.equal(Model.pillText({ valid: true, configured: true, stopped: true, queue: [] }), "Replies: at cap")
  assert.equal(Model.pillText({ valid: true, configured: true, stopped: false,
    queue: [{ done: false }, { done: false }, { done: true }] }), "Replies: 2")
  assert.equal(Model.pillText({ valid: true, configured: true, stopped: false,
    queue: [{ done: true }] }), "")
})

// ---- summary (BYOK) ----

test("summaryRequestBody bans hype and pins facts; parseSummary extracts content", () => {
  const body = JSON.parse(Model.summaryRequestBody("m", "Post: x\nReplies: 3"))
  assert.equal(body.max_tokens, 700)
  assert.ok(body.messages[0].content.indexOf("no em dashes") >= 0)
  assert.equal(Model.parseSummary(fixture("chat-completion.json")).length > 0, true)
  assert.equal(Model.parseSummary("{}"), "")
})

test("summaryContext redacts PII out of quotes before the prompt", () => {
  const ctx = Model.summaryContext({
    postText: "p", totalReplies: 1, buckets: Model.bucketCounts([]),
    quotes: [{ text: "email me at leak@evil.com", username: "u", bucket: "question" }]
  })
  assert.ok(ctx.indexOf("leak@evil.com") === -1)
})

// ---- state record ----

test("parseState round-trips the poller's record and sanitizes on read", () => {
  const state = {
    generatedAt: NOW_MS, configured: true, stopped: false, capUsd: 8,
    account: { username: "testfounder", last4: "AB12" },
    ledger: { month: "2026-08", posts: 100, dollars: 0.5 },
    queue: [{ id: "1", text: "q", authorUsername: "u", bucket: "gripe",
      substance: 0.6, dupCount: 1, createdMs: NOW_MS,
      url: "https://x.com/u/status/1", done: false }],
    posts: [{ postId: "9", postText: "p", totalReplies: 3, newReplies: 1,
      velocity: 0.5, buckets: { gripe: 1 },
      quotes: [{ text: "t", username: "u", bucket: "gripe" }], summary: "s" }]
  }
  const parsed = Model.parseState(JSON.stringify(state))
  assert.equal(parsed.valid, true)
  assert.equal(parsed.configured, true)
  assert.equal(parsed.account.last4, "AB12")
  assert.equal(parsed.queue.length, 1)
  assert.equal(parsed.posts.length, 1)
  assert.equal(parsed.posts[0].quotes.length, 1)
})

test("parseState rejects a bad url and an unknown bucket", () => {
  const state = {
    configured: true,
    queue: [{ id: "1", text: "q", bucket: "evil", url: "javascript:alert(1)", done: false }],
    posts: []
  }
  const parsed = Model.parseState(JSON.stringify(state))
  assert.equal(parsed.queue[0].url, "")
  assert.equal(parsed.queue[0].bucket, "question")
})

test("parseState returns the zero object on malformed input", () => {
  assert.equal(Model.parseState("").valid, false)
  assert.equal(Model.parseState("{oops").valid, false)
})

// ---- manifest hygiene ----

test("BUCKETS and defaults are self-consistent", () => {
  assert.deepEqual(Model.BUCKETS, ["praise", "gripe", "question", "feature_ask", "noise"])
  assert.equal(Model.DEFAULT_COST_PER_POST, 0.005)
  assert.ok(Model.SUBSTANCE_FLOOR > 0 && Model.SUBSTANCE_FLOOR < 1)
})

// ---------------------------------------------------------------------------
// Summary endpoint policy.
//
// Reported by the marketplace reviewer on submission 1230: the advertised
// optional-summary flow rejected its own documented local HTTP endpoints. The
// README sells Ollama at http://localhost:11434/v1 and LM Studio at
// http://localhost:1234/v1 and promises local http is exempt from the
// https-only rule, but the code tested /^https:\/\/\S+$/ and also passed
// --proto =https to curl, so both were refused twice over.
test("summaryEndpoint accepts the local runtimes the README advertises", () => {
  for (const u of ["http://localhost:11434/v1", "http://localhost:1234/v1",
                   "http://127.0.0.1:8080/v1", "http://[::1]:11434/v1"]) {
    const r = Model.summaryEndpoint(u)
    assert.equal(r.ok, true, u)
    assert.equal(r.proto, "http", u)
  }
})

test("summaryEndpoint keeps every remote endpoint on https", () => {
  const r = Model.summaryEndpoint("https://api.groq.com/openai/v1")
  assert.equal(r.ok, true)
  assert.equal(r.proto, "https")
})

test("summaryEndpoint refuses cleartext to anything that is not loopback", () => {
  // A typo in a remote host must never silently downgrade a request carrying
  // an API key to cleartext, and a hostname that merely starts with the word
  // localhost is not loopback.
  for (const u of ["http://evil.com/v1", "http://192.168.1.5/v1",
                   "http://localhost.evil.com/v1", "http://10.0.0.1/v1"]) {
    assert.equal(Model.summaryEndpoint(u).ok, false, u)
  }
})

test("summaryEndpoint refuses a non-http scheme and empty input", () => {
  for (const u of ["ftp://x/v1", "file:///etc/passwd", "", null, undefined]) {
    assert.equal(Model.summaryEndpoint(u).ok, false, String(u))
  }
})

test("summaryEndpoint strips trailing slashes so the path joins cleanly", () => {
  assert.equal(Model.summaryEndpoint("https://api.groq.com/openai/v1///").url,
               "https://api.groq.com/openai/v1")
})

// The other half of the same report: a valid single-line JSON response with no
// trailing newline was discarded. onApiResponse recovers the status code by
// reading after the LAST newline, but the summary curl omitted -w "\n%{code}",
// so such a body contained no newline at all, yielding code 0 and an EMPTY
// body. It appeared to work only when the provider happened to end its
// response with a newline. This pins the parse that the framing feeds.
test("parseSummary reads a single-line JSON body with no trailing newline", () => {
  const body = '{"choices":[{"message":{"content":"three people hit the same crash"}}]}'
  assert.equal(body.endsWith("\n"), false)
  assert.equal(Model.parseSummary(body), "three people hit the same crash")
})

test("parseSummary reads the same body when it does end with a newline", () => {
  const body = '{"choices":[{"message":{"content":"same text"}}]}\n'
  assert.equal(Model.parseSummary(body), "same text")
})

// ---------------------------------------------------------------- lane colour

test("laneHue gives each reply lane its own hue and leaves noise colourless", () => {
  // The classifier already knows what kind of reply this is, so the lane is
  // carried by colour and the queue can be triaged without reading every row.
  // Noise returns a negative sentinel on purpose: it is the lane you skip, so
  // it must never compete for attention.
  const hues = ["praise", "gripe", "question", "feature_ask"].map((b) => Model.laneHue(b))
  for (const h of hues) assert.ok(h >= 0 && h <= 1)
  assert.equal(new Set(hues).size, hues.length, "two lanes share a hue")
  for (const b of ["noise", "", null, undefined, "unknown"]) {
    assert.ok(Model.laneHue(b) < 0, String(b))
  }
})
