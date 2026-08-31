const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const root = path.join(__dirname, "..")
const read = name => fs.readFileSync(path.join(root, name), "utf8")

test("marketplace copy uses all 500 characters for the shipped reply workflow", () => {
  const manifest = JSON.parse(read("manifest.json"))
  assert.equal(manifest.description.length, 500)
  assert.equal(manifest.barWidget.description.length, 500)
  assert.equal(manifest.description, manifest.barWidget.description)
  for (const claim of [
    "drainable Omarchy queue", "The bar shows work and API spend", "open the panel",
    "questions, gripes, and asks", "volume, velocity, and bucket counts",
    "hard monthly cap stops new X API reads", "only your posts, mentions, and reply conversations",
    "never posts, DMs", "private 0600 file", "PII-redacted BYOK summaries are off by default"
  ]) assert.match(manifest.description, new RegExp(claim))
})

test("banner names and illustrates X Files rather than a generic widget", () => {
  const banner = read("assets/banner.svg")
  assert.match(banner, /X FILES/)
  assert.match(banner, /Replies: 3/)
  assert.match(banner, /NEEDS YOUR REPLY/)
  assert.match(banner, /spend meter/)
  assert.match(banner, /<(?:path|circle|rect|linearGradient)\b/)
})

test("render tooling requires exact 1280x720 provenance and approval", () => {
  const render = read("scripts/rig-render.sh")
  assert.match(render, /OMARCHY_RIG_RESOLUTION:-1280x720/)
  assert.match(render, /rawShellLogSha256/)
  assert.match(render, /visualInspection:\{status:"pending"/)
  assert.match(read("scripts/approve-preview.sh"), /product value is visible without reading the README/)
})

test("tracked source contains no unresolved merge-conflict markers", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString().split("\0").filter(Boolean)
  for (const file of files) {
    const absolute = path.join(root, file)
    if (!fs.existsSync(absolute)) continue
    const body = fs.readFileSync(absolute)
    if (body.includes(0)) continue
    assert.doesNotMatch(body.toString("utf8"), /^(?:<{7}|={7}|>{7})(?: |$)/m, file)
  }
})

test("CI pins actions and runs every local quality gate", () => {
  const workflow = read(".github/workflows/test.yml")
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/)
  for (const command of [
    "npm ci", "npm run audit:deps", "npm test", "npm run test:race",
    "npm run test:mutation", "npm run audit", "shellcheck"
  ]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("credential helper writes a private file and keeps bearer tokens out of argv", () => {
  const login = read("bin/x-files-login")
  assert.match(login, /--header @-/)
  assert.match(login, /pass the token on STDIN, not --token/)
  assert.match(login, /x-files-secure-state/)
  const secure = read("bin/x-files-secure-state")
  for (const primitive of ["O_NOFOLLOW", "O_EXCL", "flock", "fsync", "same_object"])
    assert.match(secure, new RegExp(primitive))
})

test("render story drives every read surface through an isolated fake X API", () => {
  const fixtureCurl = path.join(root, "e2e/bin/curl")
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "x-files-contract-"))
  const run = url => {
    const raw = execFileSync(fixtureCurl, ["-sS", "--", url], {
      input: "Authorization: Bearer contract-fixture\n",
      env: { ...process.env, XDG_RUNTIME_DIR: temp }
    }).toString()
    assert.match(raw, /\n200$/)
    return JSON.parse(raw.slice(0, -4))
  }

  assert.equal(run("https://api.x.com/2/users/44196397/tweets?max_results=25").data.length, 2)
  assert.equal(run("https://api.x.com/2/users/44196397/mentions?max_results=25").data.length, 1)
  assert.equal(run("https://api.x.com/2/tweets/search/recent?query=fixture").data.length, 7)
  assert.match(run("http://127.0.0.1:1234/v1/chat/completions").choices[0].message.content, /Wayland crash/)
})

test("capture hook rejects loading, leaky, or incomplete marketplace states", () => {
  const hook = read("e2e/rig-before-capture.sh")
  for (const proof of [
    ".queue | length", ".posts | length", ".ledger.posts == 10",
    "feature_ask", "Wayland crash", "stat -c", "bearer token escaped"
  ]) assert.match(hook, new RegExp(proof.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("mutation gate holds a 90 percent floor over named decision cores", () => {
  const config = JSON.parse(read("stryker.config.json"))
  assert.equal(config.thresholds.break, 90)
  assert.deepEqual(config.mutate, ["Model.js:594-705", "Model.js:890-1000"])

  const lines = read("Model.js").split("\n")
  assert.match(lines[593], /^function needsReply\(/)
  assert.match(lines[694], /^function tooltipText\(/)
  assert.match(lines[704], /^  return "X Files · " \+ parts\.join/)
  assert.match(lines[889], /^function classifyIngest\(/)
  assert.match(lines[999], /^  return queue\.slice\(0, MAX_QUEUE\)$/)
  assert.match(read("contracts/mutation-scope.md"), /plausible-looking regression/)
})
