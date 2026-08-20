// X Files data layer: pure parse/classify/score/merge functions over
// X API v2 responses plus the on-disk state record the poller CLI writes.
// No QML and no network access here. The same file loads in Quickshell (via
// `import "Model.js" as Model`), in node for the unit suite, and in the two
// CLIs (bin/x-files-login, bin/x-files-poll) via require.
//
// Lineage: the classification indicator tables, the hybrid trigram+token
// dedupe, the reporter substance scoring, and the PII redaction are ports of
// the author's x-bug-triage MCP server, re-bucketed from bug-triage lanes to
// reply-intelligence lanes (praise | gripe | question | feature_ask | noise).

// A response bigger than this is not an API body worth parsing. The curl
// argv carries the same number as --max-filesize, but that flag only binds
// when the server sends Content-Length, so the real bound lives here.
var MAX_BODY_CHARS = 2000000

// Pay-per-use pricing verified at docs.x.com/x-api/getting-started/pricing
// (2026-08-20): a post read is $0.005/resource, but "owned reads" (your app
// reading your own data) are $0.001 — a 5x swing. Replies come from other
// accounts (charged $0.005), while reading your own posts is an owned read;
// which rate a given fetch bills at is worth confirming with the first $5 of
// credits, so the per-post rate is a setting, not a constant. Monthly
// pay-per-use is capped at 3M post reads. Credits: https://console.x.com
var DEFAULT_COST_PER_POST = 0.005
var DEFAULT_MONTHLY_CAP_USD = 8

// How many of the user's own recent posts are tracked for reply fan-out,
// and how old a post may be before its conversation stops being polled.
var TRACKED_POSTS_MAX = 10
var TRACKED_POST_MAX_AGE_DAYS = 7

// Store bounds.
var MAX_REPLIES_PER_POST = 200
var MAX_QUEUE = 50

var BUCKETS = ["praise", "gripe", "question", "feature_ask", "noise"]

// Sanitize every string that comes from the network before it reaches a QML
// Text or a notification: angle brackets out (Qt AutoText promotion),
// ASCII controls out, bidi override marks and Unicode tag characters out
// (CVE-2021-42574 class; tag chars written as the surrogate pair
// DB40 DC00-DC7F so the regex needs no /u flag), length capped.
function clean(value, max) {
  var s = String(value === undefined || value === null ? "" : value)
  s = s.replace(/[<>]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\uDB40[\uDC00-\uDC7F]/g, "")
  var cap = max || 64
  return s.length > cap ? s.slice(0, cap) : s
}

function num(v) {
  var n = Number(v)
  return isNaN(n) ? 0 : n
}

// Only an https X URL ever reaches xdg-open or a notification click action.
function threadUrl(username, postId) {
  var u = String(username || "").replace(/[^A-Za-z0-9_]/g, "")
  var id = String(postId || "").replace(/[^0-9]/g, "")
  if (!u || !id) return ""
  return "https://x.com/" + u + "/status/" + id
}

// ---- X API v2 URL builders. since_id discipline everywhere: every fetch
//      asks only for what arrived after the last fetch, which is the entire
//      cost story. max_results stays at the API floor-adjacent 25; a reply
//      wave bigger than that is caught on the next poll.

// Endpoints and params verified against docs.x.com 2026-08-20:
//   GET /2/users/:id/tweets   (own posts; exclude=retweets,replies)
//   GET /2/users/:id/mentions (inbound replies/mentions)
//   GET /2/tweets/search/recent?query=conversation_id:<id>  (reply fan-out)
// All support since_id, max_results 5-100, expansions=author_id, and app-only
// BearerToken (the higher 450/15min tier). The field selector is sent as
// `tweet.fields`, the long-standing name the API still accepts; X's current
// docs also show `post.fields` as the newer alias, to confirm at live capture.
var API_BASE = "https://api.x.com/2"
var TWEET_FIELDS = "created_at,conversation_id,author_id,in_reply_to_user_id,public_metrics,referenced_tweets"
var USER_FIELDS = "username,name"
var EXPANSIONS = "author_id"

function buildUrl(path, params) {
  var qs = []
  for (var k in params) {
    if (params[k] === undefined || params[k] === "") continue
    qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
  }
  return API_BASE + "/" + path + (qs.length ? "?" + qs.join("&") : "")
}

function userByUsernameUrl(username) {
  return buildUrl("users/by/username/" + encodeURIComponent(String(username || "")), {
    "user.fields": USER_FIELDS
  })
}

function userTweetsUrl(userId, sinceId) {
  return buildUrl("users/" + encodeURIComponent(String(userId || "")) + "/tweets", {
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    expansions: EXPANSIONS,
    max_results: "25",
    exclude: "retweets,replies",
    since_id: sinceId || ""
  })
}

function mentionsUrl(userId, sinceId) {
  return buildUrl("users/" + encodeURIComponent(String(userId || "")) + "/mentions", {
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    expansions: EXPANSIONS,
    max_results: "25",
    since_id: sinceId || ""
  })
}

function conversationSearchUrl(conversationId, sinceId) {
  return buildUrl("tweets/search/recent", {
    query: "conversation_id:" + String(conversationId || ""),
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    expansions: EXPANSIONS,
    max_results: "25",
    since_id: sinceId || ""
  })
}

// ---- Rate limit plumbing (port of the triage server's header tracking).

function parseRateHeaders(headerText) {
  var out = { limit: 0, remaining: -1, resetAt: 0 }
  var lines = String(headerText || "").split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var m = /^x-rate-limit-(limit|remaining|reset):\s*(\d+)/i.exec(lines[i])
    if (!m) continue
    if (m[1].toLowerCase() === "limit") out.limit = num(m[2])
    else if (m[1].toLowerCase() === "remaining") out.remaining = num(m[2])
    else out.resetAt = num(m[2])
  }
  return out
}

function backoffMs(attempt, resetAtSec, nowMs) {
  if (resetAtSec && resetAtSec * 1000 > num(nowMs)) {
    return resetAtSec * 1000 - num(nowMs) + 1000
  }
  var ms = 1000 * Math.pow(2, num(attempt))
  return ms > 30000 ? 30000 : ms
}

// ---- Response parsing. Every parser returns a zero shape on malformed or
//      oversized input; the caller keeps last-good state.

function parseUserLookup(raw) {
  var s = String(raw || "")
  if (!s || s.length > MAX_BODY_CHARS) return null
  var data
  try { data = JSON.parse(s) } catch (e) { return null }
  if (!data || !data.data || !data.data.id) return null
  return {
    id: clean(data.data.id, 30),
    username: clean(data.data.username, 20),
    name: clean(data.data.name, 60)
  }
}

// users/:id/tweets, users/:id/mentions, and search/recent all share the v2
// tweet-list envelope. Returns the zero shape on malformed input; the
// resultCount is what the spend meter charges for, so it counts what the
// API actually returned, not what survived filtering.
function parseTweetList(raw) {
  var empty = { valid: false, tweets: [], newestId: "", resultCount: 0 }
  var s = String(raw || "")
  if (!s || s.length > MAX_BODY_CHARS) return empty
  var data
  try { data = JSON.parse(s) } catch (e) { return empty }
  if (!data || typeof data !== "object") return empty
  var users = {}
  if (data.includes && Array.isArray(data.includes.users)) {
    for (var u = 0; u < data.includes.users.length; u++) {
      var usr = data.includes.users[u]
      if (usr && usr.id) users[String(usr.id)] = {
        username: clean(usr.username, 20),
        name: clean(usr.name, 60)
      }
    }
  }
  var list = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : [])
  var tweets = []
  for (var i = 0; i < list.length && tweets.length < 100; i++) {
    var t = list[i]
    if (!t || !t.id || typeof t.text !== "string") continue
    var metrics = t.public_metrics || {}
    var author = users[String(t.author_id)] || { username: "", name: "" }
    var createdMs = Date.parse(t.created_at)
    tweets.push({
      id: clean(t.id, 30),
      text: clean(t.text, 500),
      createdMs: isNaN(createdMs) ? 0 : createdMs,
      conversationId: clean(t.conversation_id || t.id, 30),
      authorId: clean(t.author_id || "", 30),
      authorUsername: author.username,
      inReplyToUserId: clean(t.in_reply_to_user_id || "", 30),
      metrics: {
        replies: num(metrics.reply_count),
        likes: num(metrics.like_count),
        retweets: num(metrics.retweet_count),
        quotes: num(metrics.quote_count)
      }
    })
  }
  var meta = data.meta || {}
  return {
    valid: true,
    tweets: tweets,
    newestId: clean(meta.newest_id || "", 30),
    resultCount: num(meta.result_count !== undefined ? meta.result_count : list.length)
  }
}

// ---- Classification (port of the triage indicator tables, re-bucketed).
//      Order matters: obvious noise is discarded first, sarcasm reads as a
//      gripe wearing a smile, real gripe signals beat everything else, and
//      praise is checked last so "love it, but it crashes" lands where the
//      crash is.

var NOISE_INDICATORS = [
  /(?:follow\s+(?:me|back)|check\s+(?:out|my)|dm\s+(?:me|for)|giveaway|airdrop|crypto\s+(?:gem|signal))/i,
  /(?:link\s+in\s+bio|promo\s+code|discount\s+code)/i
]

var SARCASM_INDICATORS = [
  /(?:love|great|amazing|wonderful|fantastic|perfect)\s+(?:how|when|that)/i,
  /(?:totally|definitely|absolutely)\s+(?:not|broken)/i,
  /\/s\b/i,
  /(?:slow\s*clap|chef'?s?\s*kiss|🙄|😒|💀)/i,
  /(?:who\s+needs|nothing\s+like|gotta\s+love)/i
]

var GRIPE_INDICATORS = [
  /(?:bug|broken|crash|error|fail|issue|problem|not\s+working|doesn'?t\s+work|stopped\s+working)/i,
  /(?:hate|awful|terrible|worst|useless|garbage|unusable|frustrat)/i,
  /(?:slow|laggy|hangs?|freezes?|times?\s+out)/i,
  /(?:charged|billing|refund|paywall|too\s+expensive)/i
]

var FEATURE_ASK_INDICATORS = [
  /(?:would\s+be\s+(?:nice|great|awesome)|wish\s+(?:it|you|this)|please\s+add|should\s+(?:have|support))/i,
  /(?:feature\s+request|(?:can|could)\s+(?:you|we)\s+(?:add|get|have|make|support)|any\s+plans?\s+(?:to|for))/i,
  /(?:it\s+would\s+help|suggestion:|idea:|add\s+(?:an?\s+)?(?:option|toggle|setting))/i
]

var QUESTION_INDICATORS = [
  /\?\s*$/,
  /^(?:how|what|why|when|where|which|who|does|do|is|are|can|could|will|would|should)\b/i,
  /(?:how\s+(?:do|did|does|can)|what\s+(?:is|are|does)|can\s+(?:it|this|you))/i
]

var PRAISE_INDICATORS = [
  /(?:love|great|amazing|awesome|fantastic|excellent|wonderful|brilliant|incredible)\b/i,
  /(?:thank(?:s|\s+you)|kudos|congrats|congratulations|shout\s*out|props|well\s+done|nice\s+work)\b/i,
  /(?:works?\s+(?:perfectly|great|well|beautifully)|this\s+is\s+(?:great|gold|huge))/i
]

function matchesAny(text, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return true
  }
  return false
}

function classifyReply(text) {
  var t = String(text || "")
  var hasGripe = matchesAny(t, GRIPE_INDICATORS)
  if (matchesAny(t, NOISE_INDICATORS) && !hasGripe) return "noise"
  if (matchesAny(t, SARCASM_INDICATORS)) return "gripe"
  if (hasGripe) return "gripe"
  if (matchesAny(t, FEATURE_ASK_INDICATORS)) return "feature_ask"
  if (matchesAny(t, QUESTION_INDICATORS)) return "question"
  if (matchesAny(t, PRAISE_INDICATORS)) return "praise"
  return "noise"
}

// ---- Substance scoring (port of the reporter scorer, simplified to what a
//      reply can prove about itself). 0..1; the needs-reply gate sits at
//      0.35 so "+1" chains and drive-bys never reach the queue.

function substanceScore(text, metrics) {
  var t = String(text || "").trim()
  var lower = t.toLowerCase()
  if (/^(?:same\s+here|me\s+too|this|same|yep|yup|\+1|facts|lol|nice|cool|first)\b/.test(lower)
      && lower.length < 40) return 0.05
  var score = 0.2
  if (t.length > 50) score += 0.15
  if (t.length > 140) score += 0.1
  if (/\?/.test(t)) score += 0.15
  if (/(?:\d|version|v\d|build|error|step)/i.test(t)) score += 0.1
  if (/(?:because|instead|compared|specifically|example)/i.test(t)) score += 0.1
  var m = metrics || {}
  if (num(m.likes) + num(m.replies) > 0) score += 0.1
  if (num(m.likes) + num(m.replies) > 5) score += 0.1
  return score > 1 ? 1 : Math.round(score * 100) / 100
}

// ---- Hybrid dedupe (port). Trigram catches character-level edits, token
//      Jaccard catches paraphrases; token gets the higher weight because
//      replies vary more in phrasing than spelling.

function charTrigramSimilarity(a, b) {
  var ta = charTrigrams(String(a || "").toLowerCase())
  var tb = charTrigrams(String(b || "").toLowerCase())
  if (ta.length === 0 && tb.length === 0) return 1
  if (ta.length === 0 || tb.length === 0) return 0
  var setB = {}
  for (var i = 0; i < tb.length; i++) setB[tb[i]] = true
  var inter = 0
  for (var j = 0; j < ta.length; j++) if (setB[ta[j]]) inter++
  return (2 * inter) / (ta.length + tb.length)
}

function charTrigrams(s) {
  var seen = {}
  var out = []
  for (var i = 0; i + 3 <= s.length; i++) {
    var tri = s.slice(i, i + 3)
    if (!seen[tri]) { seen[tri] = true; out.push(tri) }
  }
  return out
}

function tokenJaccardSimilarity(a, b) {
  var ta = tokenizeWords(a)
  var tb = tokenizeWords(b)
  if (ta.length === 0 && tb.length === 0) return 1
  if (ta.length === 0 || tb.length === 0) return 0
  var setB = {}
  for (var i = 0; i < tb.length; i++) setB[tb[i]] = true
  var inter = 0
  var union = tb.length
  for (var j = 0; j < ta.length; j++) {
    if (setB[ta[j]]) inter++
    else union++
  }
  return union > 0 ? inter / union : 0
}

function tokenizeWords(s) {
  var seen = {}
  var out = []
  var parts = String(s || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/)
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length > 1 && !seen[parts[i]]) { seen[parts[i]] = true; out.push(parts[i]) }
  }
  return out
}

function hybridSimilarity(a, b) {
  return 0.4 * charTrigramSimilarity(a, b) + 0.6 * tokenJaccardSimilarity(a, b)
}

// Collapse near-identical replies ("+1", "same here", copy-paste chains)
// into one canonical per group, chosen by engagement. Returns the input
// items annotated in place with isCanonical and dupCount.
function collapseDuplicates(replies, threshold) {
  var th = threshold || 0.7
  var list = replies || []
  for (var z = 0; z < list.length; z++) {
    list[z].isCanonical = true
    list[z].dupCount = 0
  }
  if (list.length <= 1) return list
  var parent = []
  for (var p = 0; p < list.length; p++) parent[p] = p
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      if (hybridSimilarity(list[i].text, list[j].text) >= th) {
        parent[find(j)] = find(i)
      }
    }
  }
  var groups = {}
  for (var k = 0; k < list.length; k++) {
    var root = find(k)
    if (!groups[root]) groups[root] = []
    groups[root].push(k)
  }
  for (var g in groups) {
    var members = groups[g]
    if (members.length === 1) continue
    var best = members[0]
    for (var m = 1; m < members.length; m++) {
      if (engagement(list[members[m]]) > engagement(list[best])) best = members[m]
    }
    for (var n = 0; n < members.length; n++) {
      list[members[n]].isCanonical = members[n] === best
      list[members[n]].dupCount = members[n] === best ? members.length - 1 : 0
    }
  }
  return list
}

function engagement(reply) {
  var m = reply.metrics || {}
  return num(m.likes) + num(m.replies) * 2 + num(m.retweets) * 3 + num(m.quotes) * 4
}

// ---- PII redaction (port). Runs on any text headed into a BYOK prompt so
//      a stranger's email or a pasted key never rides to a third-party
//      completion endpoint.

function redactPii(text) {
  var flags = []
  var s = String(text || "")
  var before = s
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[redacted-email]")
  if (s !== before) flags.push("email")
  before = s
  s = s.replace(/([?&])(?:key|token|auth|secret|api_key|access_token|bearer)=[^&\s]+/gi, "$1[redacted-token]")
  if (s !== before) flags.push("url_token")
  before = s
  s = s.replace(/(?:(?:sk|pk|api|key|token|bearer|secret|auth)[-_])[a-zA-Z0-9_]{20,}/gi, "[redacted-key]")
  s = s.replace(/\b[A-Za-z0-9]{40,}\b/g, "[redacted-key]")
  if (s !== before) flags.push("api_key")
  before = s
  s = s.replace(/(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)?[0-9]{3}[-.\s]?[0-9]{4}\b/g, "[redacted-phone]")
  if (s !== before) flags.push("phone")
  return { redactedText: s, piiFlags: flags }
}

// ---- Digest per own post: the panel's card row.

function bucketCounts(replies) {
  var out = { praise: 0, gripe: 0, question: 0, feature_ask: 0, noise: 0 }
  var list = replies || []
  for (var i = 0; i < list.length; i++) {
    if (out[list[i].bucket] !== undefined) out[list[i].bucket]++
  }
  return out
}

function bucketChips(counts) {
  var order = ["gripe", "question", "feature_ask", "praise", "noise"]
  var labels = { gripe: "gripes", question: "questions", feature_ask: "asks", praise: "praise", noise: "noise" }
  var parts = []
  for (var i = 0; i < order.length; i++) {
    var n = counts[order[i]]
    if (n > 0) parts.push(n + " " + labels[order[i]])
  }
  return parts.join(" · ")
}

// Representative quotes: the highest-substance canonical reply from each of
// the two loudest non-noise buckets. Verbatim voice, never a number.
function topQuotes(replies) {
  var byBucket = {}
  var list = replies || []
  for (var i = 0; i < list.length; i++) {
    var r = list[i]
    if (r.bucket === "noise" || r.isCanonical === false) continue
    var cur = byBucket[r.bucket]
    if (!cur || r.substance > cur.substance) byBucket[r.bucket] = r
  }
  var picks = []
  for (var b in byBucket) picks.push(byBucket[b])
  picks.sort(function(a, b2) { return b2.substance - a.substance })
  var out = []
  for (var j = 0; j < picks.length && out.length < 2; j++) {
    out.push({
      text: clean(picks[j].text, 180),
      username: picks[j].authorUsername,
      bucket: picks[j].bucket
    })
  }
  return out
}

function velocityPerHour(replies, nowMs) {
  var count = 0
  var list = replies || []
  for (var i = 0; i < list.length; i++) {
    if (num(nowMs) - list[i].createdMs <= 6 * 3600000) count++
  }
  return Math.round((count / 6) * 10) / 10
}

// ---- Needs-reply gate: the queue is questions, gripes, and feature asks
//      with substance, from other people, one per duplicate group, that the
//      user has not marked done.

var NEEDS_REPLY_BUCKETS = { question: true, gripe: true, feature_ask: true }
var SUBSTANCE_FLOOR = 0.35

function needsReply(reply, selfUserId) {
  if (!reply) return false
  if (reply.authorId === String(selfUserId)) return false
  if (!NEEDS_REPLY_BUCKETS[reply.bucket]) return false
  if (reply.substance < SUBSTANCE_FLOOR) return false
  if (reply.isCanonical === false) return false
  return true
}

// ---- Spend meter. A persistent monthly ledger the poller charges per
//      returned post. The projection is linear on the month so far; the cap
//      is a hard stop, not advice.

function monthKey(nowMs) {
  return new Date(num(nowMs)).toISOString().slice(0, 7)
}

function chargeLedger(ledger, postCount, costPerPost, nowMs) {
  var key = monthKey(nowMs)
  var l = ledger && ledger.month === key
    ? { month: ledger.month, posts: num(ledger.posts), dollars: num(ledger.dollars) }
    : { month: key, posts: 0, dollars: 0 }
  l.posts += num(postCount)
  l.dollars = Math.round((l.dollars + num(postCount) * num(costPerPost)) * 10000) / 10000
  return l
}

function projectedMonthUsd(ledger, nowMs) {
  if (!ledger || ledger.month !== monthKey(nowMs)) return 0
  var d = new Date(num(nowMs))
  var dayOfMonth = d.getUTCDate()
  var daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  if (dayOfMonth < 1) return num(ledger.dollars)
  return Math.round((num(ledger.dollars) / dayOfMonth) * daysInMonth * 100) / 100
}

function usd(n) {
  return "$" + (Math.round(num(n) * 100) / 100).toFixed(2)
}

function spendText(ledger, nowMs) {
  var spent = ledger && ledger.month === monthKey(nowMs) ? num(ledger.dollars) : 0
  return usd(spent) + " this month, ~" + usd(projectedMonthUsd(ledger, nowMs)) + " projected"
}

function budgetStopped(ledger, capUsd, nowMs) {
  if (!ledger || ledger.month !== monthKey(nowMs)) return false
  return num(ledger.dollars) >= num(capUsd) && num(capUsd) > 0
}

// ---- Pill and tooltip. The pill speaks only for the queue and the hard
//      stop; digests and spend live in the panel.

function pillText(state) {
  if (!state || !state.valid) return "…"
  if (!state.configured) return "X Files: setup"
  if (state.stopped) return "Replies: paused"
  var n = 0
  var q = state.queue || []
  for (var i = 0; i < q.length; i++) if (!q[i].done) n++
  if (n === 0) return ""
  return "Replies: " + n
}

function tooltipText(state, nowMs) {
  if (!state || !state.valid) return "X Files · loading"
  if (!state.configured) return "X Files · run x-files-login to connect your X account"
  var parts = []
  var n = 0
  var q = state.queue || []
  for (var i = 0; i < q.length; i++) if (!q[i].done) n++
  parts.push(n === 0 ? "queue drained" : n + " repl" + (n === 1 ? "y needs" : "ies need") + " you")
  if (state.stopped) parts.push("PAUSED at the monthly spend cap")
  parts.push(spendText(state.ledger, nowMs))
  return "X Files · " + parts.join(" · ")
}

function ageText(thenMs, nowMs) {
  var t = num(thenMs)
  if (t <= 0) return ""
  var mins = Math.floor((num(nowMs) - t) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m ago"
  var hours = Math.floor(mins / 60)
  if (hours < 48) return hours + "h ago"
  return Math.floor(hours / 24) + "d ago"
}

// ---- Optional BYOK per-post summary (two-pass economics: classification
//      is local and free; only a post whose digest changed is worth a
//      completion, and quotes ride redacted).

function summaryCacheKey(postId, totalReplies) {
  return String(postId) + ":" + num(totalReplies)
}

function summaryContext(digest) {
  var lines = []
  lines.push("Post: " + digest.postText)
  lines.push("Replies: " + digest.totalReplies + " (" + bucketChips(digest.buckets) + ")")
  var quotes = digest.quotes || []
  for (var i = 0; i < quotes.length; i++) {
    lines.push("Quote (" + quotes[i].bucket + "): " + redactPii(quotes[i].text).redactedText)
  }
  return lines.join("\n")
}

function summaryRequestBody(model, context) {
  return JSON.stringify({
    model: String(model || ""),
    max_tokens: 700,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: "You summarize the replies to one social post for a desktop widget in two or three tight sentences. "
          + "Plain language, no hype words, no emoji, no hashtags, no em dashes. "
          + "Use only the facts provided. Never invent quotes, counts, or names."
      },
      { role: "user", content: "Summarize what the replies said:\n" + String(context || "") }
    ]
  })
}

function parseSummary(raw) {
  var s = String(raw || "")
  if (s.length > MAX_BODY_CHARS) return ""
  var data
  try { data = JSON.parse(s) } catch (e) { return "" }
  var c = data && data.choices && data.choices[0]
  var content = c && c.message ? c.message.content : ""
  if (content && content.length !== undefined && typeof content !== "string") {
    var parts = []
    for (var i = 0; i < content.length; i++) {
      var p = content[i]
      if (p && typeof p.text === "string") parts.push(p.text)
    }
    content = parts.join(" ")
  }
  return clean(content, 600)
}

// ---- State record. One writer (the poller CLI), atomic tmp+mv; the panel
//      only ever reads.

function emptyState() {
  return {
    valid: false, configured: false, stopped: false, generatedAt: 0,
    account: { username: "", last4: "" },
    ledger: { month: "", posts: 0, dollars: 0 },
    capUsd: DEFAULT_MONTHLY_CAP_USD,
    queue: [], posts: [], lastError: ""
  }
}

function parseState(raw) {
  var s = String(raw || "")
  if (!s || s.length > MAX_BODY_CHARS) return emptyState()
  var data
  try { data = JSON.parse(s) } catch (e) { return emptyState() }
  if (!data || typeof data !== "object") return emptyState()
  var out = emptyState()
  out.valid = true
  out.configured = data.configured === true
  out.stopped = data.stopped === true
  out.generatedAt = num(data.generatedAt)
  out.capUsd = num(data.capUsd) || DEFAULT_MONTHLY_CAP_USD
  out.lastError = clean(data.lastError, 100)
  if (data.account) {
    out.account.username = clean(data.account.username, 20)
    out.account.last4 = clean(data.account.last4, 4)
  }
  if (data.ledger) {
    out.ledger = {
      month: clean(data.ledger.month, 7),
      posts: num(data.ledger.posts),
      dollars: num(data.ledger.dollars)
    }
  }
  var q = Array.isArray(data.queue) ? data.queue : []
  for (var i = 0; i < q.length && out.queue.length < MAX_QUEUE; i++) {
    var it = q[i]
    if (!it || !it.id || typeof it.text !== "string") continue
    out.queue.push({
      id: clean(it.id, 30),
      text: clean(it.text, 300),
      authorUsername: clean(it.authorUsername, 20),
      bucket: BUCKETS.indexOf(String(it.bucket)) >= 0 ? String(it.bucket) : "question",
      substance: num(it.substance),
      dupCount: num(it.dupCount),
      createdMs: num(it.createdMs),
      url: /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/[0-9]+$/.test(String(it.url)) ? String(it.url) : "",
      done: it.done === true
    })
  }
  var posts = Array.isArray(data.posts) ? data.posts : []
  for (var j = 0; j < posts.length && out.posts.length < TRACKED_POSTS_MAX; j++) {
    var p = posts[j]
    if (!p || !p.postId) continue
    var quotes = []
    var rawQuotes = Array.isArray(p.quotes) ? p.quotes : []
    for (var k = 0; k < rawQuotes.length && quotes.length < 2; k++) {
      quotes.push({
        text: clean(rawQuotes[k].text, 180),
        username: clean(rawQuotes[k].username, 20),
        bucket: BUCKETS.indexOf(String(rawQuotes[k].bucket)) >= 0 ? String(rawQuotes[k].bucket) : "noise"
      })
    }
    out.posts.push({
      postId: clean(p.postId, 30),
      postText: clean(p.postText, 120),
      url: /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/[0-9]+$/.test(String(p.url)) ? String(p.url) : "",
      createdMs: num(p.createdMs),
      totalReplies: num(p.totalReplies),
      newReplies: num(p.newReplies),
      velocity: num(p.velocity),
      buckets: {
        praise: num(p.buckets && p.buckets.praise),
        gripe: num(p.buckets && p.buckets.gripe),
        question: num(p.buckets && p.buckets.question),
        feature_ask: num(p.buckets && p.buckets.feature_ask),
        noise: num(p.buckets && p.buckets.noise)
      },
      quotes: quotes,
      summary: clean(p.summary, 600)
    })
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_BODY_CHARS: MAX_BODY_CHARS,
    DEFAULT_COST_PER_POST: DEFAULT_COST_PER_POST,
    DEFAULT_MONTHLY_CAP_USD: DEFAULT_MONTHLY_CAP_USD,
    TRACKED_POSTS_MAX: TRACKED_POSTS_MAX,
    TRACKED_POST_MAX_AGE_DAYS: TRACKED_POST_MAX_AGE_DAYS,
    MAX_REPLIES_PER_POST: MAX_REPLIES_PER_POST,
    MAX_QUEUE: MAX_QUEUE,
    BUCKETS: BUCKETS,
    SUBSTANCE_FLOOR: SUBSTANCE_FLOOR,
    clean: clean,
    threadUrl: threadUrl,
    userByUsernameUrl: userByUsernameUrl,
    userTweetsUrl: userTweetsUrl,
    mentionsUrl: mentionsUrl,
    conversationSearchUrl: conversationSearchUrl,
    parseRateHeaders: parseRateHeaders,
    backoffMs: backoffMs,
    parseUserLookup: parseUserLookup,
    parseTweetList: parseTweetList,
    classifyReply: classifyReply,
    substanceScore: substanceScore,
    charTrigramSimilarity: charTrigramSimilarity,
    tokenJaccardSimilarity: tokenJaccardSimilarity,
    hybridSimilarity: hybridSimilarity,
    collapseDuplicates: collapseDuplicates,
    redactPii: redactPii,
    bucketCounts: bucketCounts,
    bucketChips: bucketChips,
    topQuotes: topQuotes,
    velocityPerHour: velocityPerHour,
    needsReply: needsReply,
    monthKey: monthKey,
    chargeLedger: chargeLedger,
    projectedMonthUsd: projectedMonthUsd,
    usd: usd,
    spendText: spendText,
    budgetStopped: budgetStopped,
    pillText: pillText,
    tooltipText: tooltipText,
    ageText: ageText,
    summaryCacheKey: summaryCacheKey,
    summaryContext: summaryContext,
    summaryRequestBody: summaryRequestBody,
    parseSummary: parseSummary,
    emptyState: emptyState,
    parseState: parseState
  }
}
