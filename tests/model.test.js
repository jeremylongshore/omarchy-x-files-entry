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

// -------------------------------------------------------- store management

function reply(over = {}) {
  return Object.assign({
    id: "r1", text: "How does this work?", authorId: "other",
    authorUsername: "reader", conversationId: "c1", replyParentId: "p1",
    createdMs: NOW_MS - 60000, metrics: { likes: 2, replies: 0, retweets: 0, quotes: 0 },
    bucket: "question", substance: 0.9, isCanonical: true, groupId: "g1", dupCount: 0
  }, over)
}

function ownPost(over = {}) {
  return Object.assign({
    id: "p1", text: "Shipping X Files", createdMs: NOW_MS - 3600000,
    conversationId: "c1", metrics: { replies: 1 }
  }, over)
}

test("user lookup URL encodes the handle and requests identity fields", () => {
  const url = Model.userByUsernameUrl("name with space")
  assert.match(url, /users\/by\/username\/name%20with%20space/)
  assert.match(url, /user.fields=username%2Cname/)
})

test("velocity, age, summary key, and tooltip helpers cover their display boundaries", () => {
  assert.equal(Model.velocityPerHour([], NOW_MS), 0)
  assert.ok(Model.velocityPerHour([reply({ createdMs: NOW_MS - 30 * 60000 })], NOW_MS) > 0)
  assert.equal(Model.ageText(0, NOW_MS), "")
  assert.equal(Model.ageText(NOW_MS - 1000, NOW_MS), "just now")
  assert.equal(Model.ageText(NOW_MS - 5 * 60000, NOW_MS), "5m ago")
  assert.equal(Model.ageText(NOW_MS - 2 * 3600000, NOW_MS), "2h ago")
  assert.equal(Model.ageText(NOW_MS - 3 * 86400000, NOW_MS), "3d ago")
  assert.equal(Model.summaryCacheKey("p1", 7), "p1:7")

  const state = { valid: true, configured: true, stopped: false,
    queue: [reply({ done: false })], ledger: { month: "2026-08", posts: 1, dollars: 0.005 } }
  assert.equal(Model.tooltipText(null, NOW_MS), "X Files · loading")
  assert.equal(Model.tooltipText({ valid: true, configured: false }, NOW_MS),
    "X Files · run x-files-login to connect your X account")
  assert.equal(Model.tooltipText(state, NOW_MS),
    "X Files · 1 reply needs you · $0.01 this month, ~$0.01 projected")
  assert.equal(Model.tooltipText(Object.assign({}, state, { stopped: true }), NOW_MS),
    "X Files · 1 reply needs you · PAUSED at the monthly spend cap · $0.01 this month, ~$0.01 projected")
  assert.equal(Model.tooltipText(Object.assign({}, state, { queue: [] }), NOW_MS),
    "X Files · queue drained · $0.01 this month, ~$0.01 projected")
})

test("emptyInternal and maxId preserve bounded poll-state invariants", () => {
  assert.deepEqual(Model.emptyInternal(), {
    firstRun: true, sinceTweets: "", sinceMentions: "", perConv: {},
    ownPosts: [], replies: {}, mentionReplies: [], doneIds: {}, notifiedIds: {},
    summaries: {}, ledger: { month: "", posts: 0, dollars: 0 }
  })
  assert.equal(Model.maxId("", "9"), "9")
  assert.equal(Model.maxId("10", ""), "10")
  assert.equal(Model.maxId("9", "10"), "10")
  assert.equal(Model.maxId("19", "20"), "20")
  assert.equal(Model.maxId("20", "19"), "20")
})

test("classifyIngest drops self replies and computes lane plus substance", () => {
  const tweets = [
    reply({ id: "self", authorId: SELF, text: "How?" }),
    reply({ id: "other", authorId: "9", text: "The panel is broken and crashes every time." })
  ]
  const out = Model.classifyIngest(tweets, SELF)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, "other")
  assert.equal(out[0].bucket, "gripe")
  assert.ok(out[0].substance >= Model.GRIPE_FLOOR)
})

test("ingestReplies routes by parent, conversation, or mentions and ignores duplicates", () => {
  const internal = Model.emptyInternal()
  internal.ownPosts = [ownPost(), ownPost({ id: "p2", conversationId: "c2" })]
  const parent = reply({ id: "r-parent", replyParentId: "p2", conversationId: "c1" })
  const conversation = reply({ id: "r-conv", replyParentId: "missing", conversationId: "c1" })
  const mention = reply({ id: "r-mention", replyParentId: "", conversationId: "elsewhere" })
  Model.ingestReplies(internal, [parent, conversation, mention, mention], SELF)
  assert.deepEqual(internal.replies.p2.map(r => r.id), ["r-parent"])
  assert.deepEqual(internal.replies.p1.map(r => r.id), ["r-conv"])
  assert.deepEqual(internal.mentionReplies.map(r => r.id), ["r-mention"])
  assert.equal(Model.allReplies(internal).length, 3)
})

test("evictOne prefers done, then non-actionable, then the oldest queue-worthy item", () => {
  const internal = Model.emptyInternal()
  const done = reply({ id: "done" })
  const noise = reply({ id: "noise", bucket: "noise", substance: 0 })
  const needed = reply({ id: "needed" })
  internal.doneIds.done = true
  const first = [needed, done, noise]
  Model.evictOne(first, internal, SELF)
  assert.deepEqual(first.map(r => r.id), ["needed", "noise"])

  const second = [needed, noise]
  Model.evictOne(second, Model.emptyInternal(), SELF)
  assert.deepEqual(second.map(r => r.id), ["needed"])

  const third = [reply({ id: "a" }), reply({ id: "b" })]
  Model.evictOne(third, Model.emptyInternal(), SELF)
  assert.deepEqual(third.map(r => r.id), ["b"])
})

test("buildQueue drains done duplicate groups, filters noise, and sorts newest first", () => {
  const internal = Model.emptyInternal()
  internal.replies.p1 = [
    reply({ id: "done", groupId: "handled", createdMs: 1 }),
    reply({ id: "same-group", groupId: "handled", createdMs: 5 }),
    reply({ id: "2", groupId: "old", createdMs: 2 }),
    reply({ id: "4", groupId: "new", createdMs: 4, bucket: "feature_ask" }),
    reply({ id: "noise", groupId: "noise", createdMs: 6, bucket: "noise", substance: 0 })
  ]
  internal.doneIds.done = true
  const queue = Model.buildQueue(internal, SELF)
  assert.deepEqual(queue.map(r => r.id), ["4", "2"])
  assert.equal(queue[0].url, "https://x.com/reader/status/4")
  assert.equal(queue[0].done, false)
})

test("buildDigests combines reply truth, unread state, quotes, velocity, and cached summary", () => {
  const internal = Model.emptyInternal()
  internal.ownPosts = [
    ownPost(),
    ownPost({ id: "empty", conversationId: "empty", metrics: { replies: 0 } })
  ]
  internal.replies.p1 = [
    reply({ id: "r1", createdMs: NOW_MS - 10 * 60000 }),
    reply({ id: "r2", createdMs: NOW_MS - 20 * 60000, bucket: "gripe", groupId: "g2" })
  ]
  internal.doneIds.r1 = true
  internal.notifiedIds.r2 = true
  internal.summaries[Model.summaryCacheKey("p1", 2)] = "Two useful replies."
  const digests = Model.buildDigests(internal, NOW_MS)
  assert.equal(digests.length, 1)
  assert.equal(digests[0].postId, "p1")
  assert.equal(digests[0].totalReplies, 2)
  assert.equal(digests[0].newReplies, 0)
  assert.ok(digests[0].velocity > 0)
  assert.equal(digests[0].summary, "Two useful replies.")
  assert.ok(digests[0].quotes.length > 0)
})

test("absorbOwnPosts deduplicates, ages out, caps, and prunes orphaned stores", () => {
  const internal = Model.emptyInternal()
  const old = ownPost({ id: "old", conversationId: "old-c", createdMs: NOW_MS - 8 * 86400000 })
  internal.ownPosts = [old, ownPost()]
  internal.replies.old = [reply({ id: "old-r" })]
  internal.replies.orphan = [reply({ id: "orphan-r" })]
  internal.perConv["old-c"] = "1"
  internal.perConv.orphan = "2"
  const incoming = [ownPost({ text: "newer duplicate", createdMs: NOW_MS })]
  Model.absorbOwnPosts(internal, incoming, NOW_MS)
  assert.deepEqual(internal.ownPosts.map(p => p.id), ["p1"])
  assert.equal(internal.ownPosts[0].text, "newer duplicate")
  assert.equal(internal.replies.old, undefined)
  assert.equal(internal.replies.orphan, undefined)
  assert.equal(internal.perConv["old-c"], undefined)
  assert.equal(internal.perConv.orphan, undefined)
})

test("absorbOwnPosts enforces the tracked-post cap", () => {
  const internal = Model.emptyInternal()
  const posts = []
  for (let i = 0; i < Model.TRACKED_POSTS_MAX + 3; i++) {
    posts.push(ownPost({ id: `p${i}`, conversationId: `c${i}`, createdMs: NOW_MS - i }))
  }
  Model.absorbOwnPosts(internal, posts, NOW_MS)
  assert.equal(internal.ownPosts.length, Model.TRACKED_POSTS_MAX)
  assert.equal(internal.ownPosts[0].id, "p0")
})

test("nextFanoutPost respects cap and selects only conversations with missing replies", () => {
  const internal = Model.emptyInternal()
  internal.ownPosts = [
    ownPost({ id: "full", metrics: { replies: 1 } }),
    ownPost({ id: "owed", conversationId: "c2", metrics: { replies: 2 } })
  ]
  internal.replies.full = [reply({ id: "have" })]
  internal.replies.owed = [reply({ id: "one" })]
  assert.equal(Model.nextFanoutPost(internal, 0, 2).id, "owed")
  assert.equal(Model.nextFanoutPost(internal, 2, 2), null)
  internal.replies.owed.push(reply({ id: "two" }))
  assert.equal(Model.nextFanoutPost(internal, 0, 2), null)
})

// ---------------------------------------------------------- defensive edges

test("URL builders handle absent ids and omit empty query fields", () => {
  assert.equal(Model.threadUrl("user", ""), "")
  assert.match(Model.userByUsernameUrl(null), /users\/by\/username\//)
  assert.match(Model.userTweetsUrl(null, null), /users\/\/tweets/)
  assert.doesNotMatch(Model.mentionsUrl(null, null), /since_id/)
  assert.match(Model.conversationSearchUrl(null, null), /conversation_id%3A/)
})

test("rate and response parsers keep sparse inputs inert", () => {
  assert.deepEqual(Model.parseRateHeaders(null), { limit: 0, remaining: -1, resetAt: 0 })
  assert.deepEqual(Model.parseRateHeaders("x-other: 1\nx-rate-limit-limit: 5"),
    { limit: 5, remaining: -1, resetAt: 0 })
  assert.equal(Model.parseUserLookup("x".repeat(Model.MAX_BODY_CHARS + 1)), null)
  assert.equal(Model.parseUserLookup(JSON.stringify({ data: {} })), null)
})

test("tweet parser handles single, sparse, and rejected records safely", () => {
  const body = JSON.stringify({
    data: { id: "1", text: "hello", created_at: "bad", author_id: "missing", public_metrics: null },
    includes: { users: [null, { id: "missing", username: "u", name: "User" }] }
  })
  const parsed = Model.parseTweetList(body)
  assert.equal(parsed.valid, true)
  assert.equal(parsed.tweets.length, 1)
  assert.equal(parsed.tweets[0].createdMs, 0)
  assert.equal(parsed.tweets[0].conversationId, "1")
  assert.equal(parsed.tweets[0].authorUsername, "u")
  assert.equal(parsed.resultCount, 1)
  assert.equal(parsed.newestId, "")

  const rejected = Model.parseTweetList(JSON.stringify({ data: [null, { id: "2" }, { text: "missing id" }] }))
  assert.equal(rejected.valid, true)
  assert.deepEqual(rejected.tweets, [])
  assert.equal(Model.parseTweetList("null").valid, false)
})

test("similarity helpers define empty and one-sided input semantics", () => {
  assert.equal(Model.charTrigramSimilarity("", ""), 1)
  assert.equal(Model.charTrigramSimilarity("", "abc"), 0)
  assert.equal(Model.tokenJaccardSimilarity("", ""), 1)
  assert.equal(Model.tokenJaccardSimilarity("", "word"), 0)
  assert.equal(Model.tokenJaccardSimilarity("same same", "same"), 1)
})

test("substance scoring covers every evidence increment and clamps at one", () => {
  const text = "Because version 12 specifically fails at step 3, compared with the prior build? " + "detail ".repeat(30)
  assert.equal(Model.substanceScore(text, { likes: 6, replies: 1 }), 1)
  assert.equal(Model.substanceScore("plain reply", null), 0.2)
})

test("dedupe handles empty, singleton, explicit thresholds, and engagement tie-breaks", () => {
  assert.deepEqual(Model.collapseDuplicates(null), [])
  const one = [reply({ id: "1" })]
  assert.equal(Model.collapseDuplicates(one), one)
  assert.equal(one[0].isCanonical, true)
  const pair = [
    reply({ id: "1", text: "same crash report", metrics: {} }),
    reply({ id: "2", text: "same crash report", metrics: { quotes: 2 } })
  ]
  Model.collapseDuplicates(pair, 0.9)
  assert.equal(pair[1].isCanonical, true)
  assert.equal(pair[1].dupCount, 1)
})

test("redaction identifies URL tokens and unprefixed long keys", () => {
  const rawKey = "A".repeat(45)
  const r = Model.redactPii(`https://x.test/?token=secret-value&next=1 ${rawKey}`)
  assert.doesNotMatch(r.redactedText, /secret-value/)
  assert.doesNotMatch(r.redactedText, new RegExp(rawKey))
  assert.ok(r.piiFlags.includes("url_token"))
  assert.ok(r.piiFlags.includes("api_key"))
  assert.deepEqual(Model.redactPii("safe text").piiFlags, [])
})

test("digest helpers handle empty, unknown, old, and competing replies", () => {
  assert.deepEqual(Model.bucketCounts(null), { praise: 0, gripe: 0, question: 0, feature_ask: 0, noise: 0 })
  assert.equal(Model.bucketChips({ praise: 0, gripe: 0, question: 0, feature_ask: 0, noise: 0 }), "")
  assert.deepEqual(Model.topQuotes(null), [])
  const quotes = Model.topQuotes([
    reply({ id: "a", bucket: "question", substance: 0.4, isCanonical: false }),
    reply({ id: "b", bucket: "question", substance: 0.5 }),
    reply({ id: "c", bucket: "question", substance: 0.9 }),
    reply({ id: "d", bucket: "noise", substance: 1 })
  ])
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].text, "How does this work?")
  assert.equal(Model.velocityPerHour([reply({ createdMs: NOW_MS - 7 * 3600000 })], NOW_MS), 0)
})

test("needsReply rejects null, low-substance, noncanonical, and unsupported lanes", () => {
  assert.equal(Model.needsReply(null, SELF), false)
  assert.equal(Model.needsReply(reply({ bucket: "praise" }), SELF), false)
  assert.equal(Model.needsReply(reply({ substance: 0.1 }), SELF), false)
  assert.equal(Model.needsReply(reply({ isCanonical: false }), SELF), false)
})

test("spend helpers cover invalid caps, old months, negatives, and zero projection", () => {
  assert.equal(Model.projectedMonthUsd(null, NOW_MS), 0)
  assert.equal(Model.projectedMonthUsd({ month: "2025-01", dollars: 9 }, NOW_MS), 0)
  assert.equal(Model.spendText(null, NOW_MS).startsWith("$0.00"), true)
  assert.equal(Model.spendFraction({ month: "2026-08", dollars: -1 }, 8, NOW_MS), 0)
  assert.equal(Model.spendFraction({ month: "2026-08", dollars: 1 }, 0, NOW_MS), 0)
  assert.equal(Model.budgetStopped({ month: "2026-08", dollars: 9, posts: 9 }, 0, NOW_MS), false)
  assert.equal(Model.spendNearCap({ month: "2026-08", dollars: 6.4 }, 8, NOW_MS), true)
})

test("summary parser supports typed parts and rejects oversized or malformed content", () => {
  const typed = JSON.stringify({ choices: [{ message: { content: [
    null, { type: "image" }, { text: 3 }, { type: "text", text: "First" }, { type: "text", text: "Second" }
  ] } }] })
  assert.equal(Model.parseSummary(typed), "First Second")
  assert.equal(Model.parseSummary("x".repeat(Model.MAX_BODY_CHARS + 1)), "")
  assert.equal(Model.parseSummary("not json"), "")
  assert.equal(Model.parseSummary(JSON.stringify({ choices: [] })), "")
})

test("emptyState and sparse parseState retain every public field", () => {
  assert.deepEqual(Model.emptyState(), {
    valid: false, generatedAt: 0, configured: false, stopped: false,
    account: { username: "", last4: "" },
    ledger: { month: "", posts: 0, dollars: 0 },
    capUsd: Model.DEFAULT_MONTHLY_CAP_USD, spendMeter: "Compact",
    queue: [], posts: [], lastError: ""
  })
  assert.equal(Model.parseState("x".repeat(Model.MAX_BODY_CHARS + 1)).valid, false)
  const parsed = Model.parseState(JSON.stringify({ queue: [null, { id: "1" }], posts: [null, {}] }))
  assert.equal(parsed.valid, true)
  assert.deepEqual(parsed.queue, [])
  assert.deepEqual(parsed.posts, [])
})

test("store helpers accept empty input without changing the working set", () => {
  const internal = Model.emptyInternal()
  assert.equal(Model.ingestReplies(internal, null, SELF), internal)
  assert.equal(Model.absorbOwnPosts(internal, null, NOW_MS), internal)
  assert.deepEqual(Model.classifyIngest(null, SELF), [])
  assert.deepEqual(Model.allReplies(internal), [])
})
