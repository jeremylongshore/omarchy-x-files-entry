const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const { once } = require("node:events")

const helper = path.join(__dirname, "..", "bin", "x-files-secure-state")
const token = "fixture_bearer_token_1234567890"

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-files-state-"))
  return { root, dir: path.join(root, "state", "omarchy", "x-files"),
    env: { ...process.env, HOME: root, XDG_STATE_HOME: path.join(root, "state") } }
}
function run(x, op = "--write", input = `${token}\n44196397\ntestfounder\n`) {
  return spawnSync(helper, [op], { encoding: "utf8", env: x.env, input, timeout: 3000 })
}
function cleanup(x) { fs.rmSync(x.root, { recursive: true, force: true }) }
async function waitFor(file, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${file}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function stop(child) {
  if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit") }
}

test("credentials publish as private valid X Files JSON", () => {
  const x = setup(); const result = run(x)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.statSync(x.dir).mode & 0o777, 0o700)
  const final = path.join(x.dir, "credentials.json")
  assert.equal(fs.statSync(final).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(final, "utf8")),
    { bearerToken: token, userId: "44196397", username: "testfounder" })
  cleanup(x)
})

test("a symlinked final entry is replaced without touching its victim", () => {
  const x = setup(); fs.mkdirSync(x.dir, { recursive: true })
  const victim = path.join(x.root, "victim"); fs.writeFileSync(victim, "precious", { mode: 0o640 })
  fs.symlinkSync(victim, path.join(x.dir, "credentials.json"))
  const result = run(x); assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(victim, "utf8"), "precious")
  assert.equal(fs.lstatSync(path.join(x.dir, "credentials.json")).isSymbolicLink(), false)
  cleanup(x)
})

test("same-UID final and temporary entry swaps fail closed", async () => {
  const x = setup(); fs.mkdirSync(x.dir, { recursive: true })
  const victim = path.join(x.root, "victim-temp"); fs.writeFileSync(victim, "precious", { mode: 0o640 })
  const ready = path.join(x.root, "temp-ready")
  const racer = spawn(process.execPath,
    [path.join(__dirname, "fixtures", "credential-swap-racer.js"), x.dir, victim, ready],
    { stdio: "ignore" })
  await waitFor(ready)
  const attempts = []
  for (let i = 0; i < 60; i++) attempts.push(run(x))
  await waitFor(`${ready}.attacked`); await stop(racer)
  assert.equal(fs.readFileSync(victim, "utf8"), "precious")
  assert.equal(fs.statSync(victim).mode & 0o777, 0o640)
  assert.ok(attempts.some(result => result.status !== 0), "an identity race fails closed")
  for (const name of fs.readdirSync(x.dir)) {
    const entry = path.join(x.dir, name)
    if (fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry)
  }
  assert.equal(run(x).status, 0)
  cleanup(x)
})

test("same-UID parent directory swaps cannot redirect publication", async () => {
  const x = setup(); fs.mkdirSync(x.dir, { recursive: true })
  const victim = path.join(x.root, "victim-parent"); fs.mkdirSync(victim)
  const ready = path.join(x.root, "parent-ready")
  const racer = spawn(process.execPath,
    [path.join(__dirname, "fixtures", "credential-parent-racer.js"), x.dir, victim, ready],
    { stdio: "ignore" })
  await waitFor(ready)
  for (let i = 0; i < 60; i++) run(x)
  await waitFor(`${ready}.attacked`); await stop(racer)
  assert.equal(fs.existsSync(path.join(victim, "credentials.json")), false)
  cleanup(x)
})

test("a FIFO final entry never blocks write or forget", () => {
  const x = setup(); fs.mkdirSync(x.dir, { recursive: true })
  const final = path.join(x.dir, "credentials.json")
  assert.equal(spawnSync("mkfifo", [final]).status, 0)
  const result = run(x); assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.lstatSync(final).isFile(), true)
  assert.equal(run(x, "--forget", "").status, 0)
  assert.equal(fs.existsSync(final), false)
  cleanup(x)
})

test("oversized or malformed credential input fails closed", () => {
  const x = setup()
  for (const input of ["x".repeat(5000), "bad\nuser\n", `${token}\nnot-numeric\ntestfounder\n`, `${token}\n1\nnot valid!\n`])
    assert.notEqual(run(x, "--write", input).status, 0)
  assert.equal(fs.existsSync(path.join(x.dir, "credentials.json")), false)
  cleanup(x)
})

test("a symlinked state parent is refused", () => {
  const x = setup(); const victim = path.join(x.root, "victim-state"); fs.mkdirSync(victim)
  fs.mkdirSync(path.dirname(x.env.XDG_STATE_HOME), { recursive: true })
  fs.symlinkSync(victim, x.env.XDG_STATE_HOME)
  assert.notEqual(run(x).status, 0)
  assert.deepEqual(fs.readdirSync(victim), [])
  cleanup(x)
})
