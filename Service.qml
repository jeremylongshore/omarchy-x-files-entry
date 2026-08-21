import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// X Files background service: owns the entire poll cycle, the spend ledger,
// and the reply store in QML, with NO external runtime. A stock Omarchy
// install has no node on the graphical session PATH (Omarchy installs it
// through mise, whose shims are not exported to the session), so this plugin
// depends on nothing but Quickshell and the curl every Omarchy box ships.
//
// The bearer token is read from credentials.json (written only by
// bin/x-files-login) and handed to curl over STDIN via `--header @-`, exactly
// as the first-party network panel passes a wifi passphrase, so it never
// appears in a process argv and is never visible to ps.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string moduleId: "io.github.jeremylongshore.x-files"
  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateDir:
    (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/x-files"
  readonly property string statePath: stateDir + "/state.json"
  readonly property string internalPath: stateDir + "/internal.json"
  readonly property string credsPath: stateDir + "/credentials.json"

  readonly property int pollIntervalSec: 900
  readonly property int fetchTimeoutSec: 20
  readonly property int notifyCap: 3
  readonly property int summaryCapPerPoll: 3
  readonly property int fanoutCapPerPoll: 5

  // ---- Settings, read from this plugin's bar-layout entry in shell.json.
  property string notificationsMode: "On"
  property real monthlyCapUsd: Model.DEFAULT_MONTHLY_CAP_USD
  property real costPerPost: Model.DEFAULT_COST_PER_POST
  property string spendMeterMode: "Compact"
  property string aiBaseUrl: ""
  property string aiModel: ""
  property string aiApiKey: ""

  // ---- Credentials (read-only here; only bin/x-files-login writes them).
  property string bearerToken: ""
  property string userId: ""
  property string username: ""
  readonly property bool configured: bearerToken !== "" && userId !== ""

  // ---- Store.
  property var internal: Model.emptyInternal()
  property var queue: []
  property var posts: []
  property double generatedAt: 0
  property string lastError: ""
  property bool stateLoaded: false
  property bool polling: false

  // Poll-run scratch.
  property int fanned: 0
  property var pendingNotifications: []
  property var summaryTargets: []
  property int summaryIndex: -1

  readonly property bool stopped:
    Model.budgetStopped(internal.ledger, monthlyCapUsd, Date.now())

  signal stateChanged()

  // ------------------------------------------------------------- settings

  function readSettings() {
    var conf
    try { conf = JSON.parse(shellConfigFile.text() || "") } catch (e) { return }
    if (!conf || !conf.bar || !conf.bar.layout) return
    var zones = ["left", "center", "right"]
    for (var z = 0; z < zones.length; z++) {
      var list = conf.bar.layout[zones[z]] || []
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        if (!e || e.id !== root.moduleId) continue
        root.notificationsMode = e.notifications === "Off" ? "Off" : "On"
        root.monthlyCapUsd = Number(e.monthlyCapUsd) > 0
          ? Number(e.monthlyCapUsd) : Model.DEFAULT_MONTHLY_CAP_USD
        // Clamp to the floor: an implausibly low rate would let the dollar
        // meter read ~$0 while X bills for real. The floor plus the
        // read-count ceiling bound reads regardless of price.
        root.costPerPost = Model.clampCost(e.costPerPost)
        root.spendMeterMode = Model.spendMode(e.spendMeter)
        root.aiBaseUrl = typeof e.aiBaseUrl === "string" ? e.aiBaseUrl : ""
        root.aiModel = typeof e.aiModel === "string" ? e.aiModel : ""
        root.aiApiKey = typeof e.aiApiKey === "string" ? e.aiApiKey : ""
        return
      }
    }
  }

  // ------------------------------------------------------------- fetching
  //
  // One request at a time. curlHeaderArgs keeps the Authorization header off
  // the argv: it rides stdin through `--header @-`, so `ps` never sees it.

  function apiArgs(url) {
    return ["curl", "-sS", "--proto", "=https",
      "--max-time", String(root.fetchTimeoutSec),
      "--max-filesize", String(Model.MAX_BODY_CHARS),
      "-o", "-", "-w", "\n%{http_code}",
      "--header", "@-",
      "--", url]
  }

  // Which request is in flight, so the shared handler can route the response.
  property string phase: ""          // "own" | "mentions" | "conv" | "summary"
  property string convPostId: ""

  function startRequest(kind, url) {
    root.phase = kind
    apiProc.command = root.apiArgs(url)
    apiProc.running = true
  }

  function overCap() {
    return Model.budgetStopped(root.internal.ledger, root.monthlyCapUsd, Date.now())
  }

  function charge(n) {
    root.internal.ledger = Model.chargeLedger(
      root.internal.ledger, n, root.costPerPost, Date.now())
  }

  // ---------------------------------------------------------------- poll

  function poll() {
    if (root.polling || !root.stateLoaded) return
    root.readSettings()
    if (!root.configured) { root.persist(); return }
    if (root.overCap()) { root.persist(); return }
    root.polling = true
    root.fanned = 0
    root.lastError = ""
    root.startRequest("own", Model.userTweetsUrl(root.userId, root.internal.sinceTweets))
  }

  function onApiResponse(raw) {
    var text = String(raw || "")
    var nl = text.lastIndexOf("\n")
    var code = nl >= 0 ? parseInt(text.slice(nl + 1), 10) || 0 : 0
    var body = nl >= 0 ? text.slice(0, nl) : ""
    var kind = root.phase
    root.phase = ""

    if (kind === "summary") { root.onSummaryResponse(code, body); return }

    if (code === 200) {
      var parsed = Model.parseTweetList(body)
      if (parsed.valid) {
        root.charge(parsed.resultCount)
        if (kind === "own") {
          if (parsed.newestId)
            root.internal.sinceTweets = Model.maxId(root.internal.sinceTweets, parsed.newestId)
          Model.absorbOwnPosts(root.internal, parsed.tweets, Date.now())
        } else if (kind === "mentions") {
          if (parsed.newestId)
            root.internal.sinceMentions = Model.maxId(root.internal.sinceMentions, parsed.newestId)
          Model.ingestReplies(root.internal,
            Model.classifyIngest(parsed.tweets, root.userId), root.userId)
        } else if (kind === "conv") {
          if (parsed.newestId) {
            root.internal.perConv[root.convPostId] =
              Model.maxId(root.internal.perConv[root.convPostId], parsed.newestId)
          }
          Model.ingestReplies(root.internal,
            Model.classifyIngest(parsed.tweets, root.userId), root.userId)
        }
      }
    } else if (code === 429) {
      root.lastError = "rate limited"
    } else if (code !== 0) {
      root.lastError = "HTTP " + code
    } else {
      root.lastError = "fetch failed"
    }

    root.advance(kind)
  }

  // Drive the sequence: own posts, then mentions, then a bounded reply
  // fan-out, then optional summaries, then finish. The cap is re-checked
  // before every request so a cycle that starts under it cannot overshoot.
  function advance(justFinished) {
    if (justFinished === "own") {
      if (root.overCap()) { root.finishPoll(); return }
      root.startRequest("mentions", Model.mentionsUrl(root.userId, root.internal.sinceMentions))
      return
    }
    // mentions or conv both fall through to the fan-out decision.
    if (justFinished === "conv") root.fanned++
    if (root.overCap()) { root.finishPoll(); return }
    var post = Model.nextFanoutPost(root.internal, root.fanned, root.fanoutCapPerPoll)
    if (post) {
      root.convPostId = post.conversationId
      root.startRequest("conv",
        Model.conversationSearchUrl(post.conversationId, root.internal.perConv[post.conversationId]))
      return
    }
    root.startSummaries()
  }

  // ----------------------------------------------------------- summaries
  //
  // Optional BYOK. Two-pass by design: classification is local and free, so
  // only a post whose conversation actually grew is worth a completion.

  function startSummaries() {
    var urlOk = /^https:\/\/\S+$/.test(root.aiBaseUrl)
    if (!urlOk || !root.aiModel || !root.aiApiKey) { root.finishPoll(); return }
    var digests = Model.buildDigests(root.internal, Date.now())
    var targets = []
    for (var i = 0; i < digests.length && targets.length < root.summaryCapPerPoll; i++) {
      var d = digests[i]
      if (d.totalReplies < 3) continue
      var key = Model.summaryCacheKey(d.postId, (root.internal.replies[d.postId] || []).length)
      if (root.internal.summaries[key]) continue
      targets.push({ digest: d, key: key })
    }
    root.summaryTargets = targets
    root.summaryIndex = -1
    root.nextSummary()
  }

  function nextSummary() {
    root.summaryIndex++
    if (root.summaryIndex >= root.summaryTargets.length) { root.finishPoll(); return }
    var t = root.summaryTargets[root.summaryIndex]
    var body = Model.summaryRequestBody(root.aiModel, Model.summaryContext(t.digest))
    var url = root.aiBaseUrl.replace(/\/+$/, "") + "/chat/completions"
    root.phase = "summary"
    // --proto =https and the -- terminator pin curl to an https POST at the
    // configured base URL; the API key rides stdin, never argv.
    apiProc.command = ["curl", "-fsS", "--proto", "=https",
      "--max-time", "30", "--max-filesize", "1000000",
      "-H", "Content-Type: application/json",
      "--header", "@-",
      "-d", body, "--", url]
    apiProc.running = true
  }

  function onSummaryResponse(code, body) {
    var t = root.summaryTargets[root.summaryIndex]
    var text = Model.parseSummary(body)
    if (t && text) root.internal.summaries[t.key] = text
    root.nextSummary()
  }

  // ------------------------------------------------------------- finish

  function finishPoll() {
    var nowMs = Date.now()

    // Summary cache hygiene: keep only keys for tracked posts.
    var live = {}
    for (var j = 0; j < root.internal.ownPosts.length; j++) {
      var pid = root.internal.ownPosts[j].id
      var k = Model.summaryCacheKey(pid, (root.internal.replies[pid] || []).length)
      if (root.internal.summaries[k]) live[k] = root.internal.summaries[k]
    }
    root.internal.summaries = live

    var q = Model.buildQueue(root.internal, root.userId)

    // Notifications for queue items never notified before. Nothing on the
    // first run: history is not news.
    if (root.internal.firstRun) {
      for (var f = 0; f < q.length; f++) root.internal.notifiedIds[q[f].id] = true
      root.internal.firstRun = false
    } else if (root.notificationsMode === "On") {
      var fresh = []
      for (var i = 0; i < q.length; i++) {
        if (!q[i].done && !root.internal.notifiedIds[q[i].id]) fresh.push(q[i])
      }
      for (var m = 0; m < fresh.length; m++) root.internal.notifiedIds[fresh[m].id] = true
      root.notifyFresh(fresh)
    }

    root.generatedAt = nowMs
    root.polling = false
    root.persist()
  }

  function notifyFresh(fresh) {
    if (!fresh || fresh.length === 0) return
    if (fresh.length > root.notifyCap) {
      root.sendNotification(["-u", "low", "--app-name", "X Files"],
        "X Files", fresh.length + " replies need you")
      return
    }
    root.pendingNotifications = fresh.slice(0)
    root.sendNextNotification()
  }

  function sendNextNotification() {
    if (root.pendingNotifications.length === 0) return
    var it = root.pendingNotifications[0]
    root.pendingNotifications = root.pendingNotifications.slice(1)
    var flags = ["-u", "low", "--app-name", "X Files"]
    // The click action is dispatched by the shell as `bash -lc "<value>"`, so
    // the URL is single-quoted. Safe only because threadUrl builds it from a
    // [A-Za-z0-9_] handle and a numeric id; the re-test refuses to build the
    // action if that ever regresses.
    if (it.url && /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/[0-9]+$/.test(it.url)) {
      flags.push("--exec", "xdg-open '" + it.url + "'")
    }
    root.sendNotification(flags,
      "@" + it.authorUsername + " (" + it.bucket.replace("_", " ") + ")",
      it.text.slice(0, 120))
  }

  // Flags first, reply-derived positionals last behind "--", with a
  // leading-dash strip, so a reply starting with a dash cannot be parsed as
  // an option.
  function sendNotification(flags, headline, body) {
    var args = flags.concat(["--", root.stripLead(headline)])
    if (body !== undefined) args.push(root.stripLead(body))
    notifyProc.command = ["omarchy-notification-send"].concat(args)
    notifyProc.running = true
  }

  function stripLead(s) {
    return String(s === undefined ? "" : s).replace(/^[-\s]+/, "")
  }

  // ------------------------------------------------------------ mutations
  //
  // Synchronous in-memory mutation plus a persist. This service is the single
  // owner of the store, so a keystroke can never be dropped or reverted by a
  // racing writer.

  function markDone(ids) {
    if (!ids || ids.length === 0) return
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i]).replace(/[^0-9]/g, "")
      if (id) root.internal.doneIds[id] = true
    }
    root.persist()
  }

  function markAllDone() {
    for (var i = 0; i < root.queue.length; i++) root.internal.doneIds[root.queue[i].id] = true
    root.persist()
  }

  // ----------------------------------------------------------- persistence

  function persist() {
    var nowMs = Date.now()
    root.queue = Model.buildQueue(root.internal, root.userId)
    root.posts = Model.buildDigests(root.internal, nowMs)
    stateFile.setText(JSON.stringify({
      generatedAt: root.generatedAt,
      configured: root.configured,
      stopped: Model.budgetStopped(root.internal.ledger, root.monthlyCapUsd, nowMs),
      capUsd: root.monthlyCapUsd,
      spendMeter: root.spendMeterMode,
      // Only the last four characters of the token ever leave credentials.json.
      account: { username: root.username, last4: root.bearerToken.slice(-4) },
      ledger: root.internal.ledger,
      queue: root.queue,
      posts: root.posts,
      lastError: root.lastError
    }))
    internalFile.setText(JSON.stringify(root.internal))
    root.stateChanged()
  }

  function loadCredentials(raw) {
    var c
    try { c = JSON.parse(String(raw || "")) } catch (e) { c = null }
    if (c && c.bearerToken && c.userId) {
      root.bearerToken = String(c.bearerToken)
      root.userId = String(c.userId)
      root.username = String(c.username || "")
    } else {
      root.bearerToken = ""
      root.userId = ""
      root.username = ""
    }
    root.maybeStart()
  }

  function loadInternal(raw) {
    var d
    try { d = JSON.parse(String(raw || "")) } catch (e) { d = null }
    if (d && d.ownPosts && d.replies) {
      // Fill any field a older/partial record is missing.
      var base = Model.emptyInternal()
      for (var k in base) if (d[k] === undefined) d[k] = base[k]
      root.internal = d
    }
    root.stateLoaded = true
    root.maybeStart()
  }

  property bool credsLoaded: false

  function maybeStart() {
    if (!root.stateLoaded) return
    root.readSettings()
    root.persist()
    root.poll()
  }

  // ------------------------------------------------------------------ procs

  Process {
    id: apiProc
    stdinEnabled: true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.onApiResponse(text)
    }
    onStarted: {
      // The Authorization header goes over stdin so the token is never in an
      // argv. The summary phase authenticates with the BYOK key instead.
      var secret = root.phase === "summary" ? root.aiApiKey : root.bearerToken
      apiProc.write("Authorization: Bearer " + secret + "\n")
      apiProc.stdinEnabled = false
    }
    onExited: function(code) {
      if (code !== 0 && root.phase !== "") {
        // Nothing collected: record the failure and keep the sequence moving.
        var kind = root.phase
        root.phase = ""
        root.lastError = "fetch failed"
        if (kind === "summary") root.nextSummary()
        else root.advance(kind)
      }
    }
  }

  Process {
    id: notifyProc
    onExited: root.sendNextNotification()
  }

  // ------------------------------------------------------------- file views

  FileView {
    id: credsFile
    path: root.credsPath
    watchChanges: true
    printErrors: false
    onLoaded: { root.credsLoaded = true; root.loadCredentials(text()) }
    onLoadFailed: { root.credsLoaded = true; root.loadCredentials("") }
    onFileChanged: reload()
  }

  FileView {
    id: internalFile
    path: root.internalPath
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadInternal(text())
    onLoadFailed: root.loadInternal("")
  }

  FileView {
    id: stateFile
    path: root.statePath
    atomicWrites: true
    printErrors: false
  }

  FileView {
    id: shellConfigFile
    path: (Quickshell.env("XDG_CONFIG_HOME") || root.home + "/.config") + "/omarchy/shell.json"
    printErrors: false
  }

  Timer {
    interval: root.pollIntervalSec * 1000
    running: true
    repeat: true
    onTriggered: root.poll()
  }
}
