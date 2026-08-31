const fs = require("node:fs")
const [dir, victim, ready] = process.argv.slice(2)
const parked = `${dir}.parked`
fs.writeFileSync(ready, "ready")
for (;;) {
  try {
    fs.renameSync(dir, parked)
    fs.symlinkSync(victim, dir)
    fs.writeFileSync(`${ready}.attacked`, "yes")
    fs.unlinkSync(dir)
    fs.renameSync(parked, dir)
  } catch {
    try { if (fs.existsSync(parked) && !fs.existsSync(dir)) fs.renameSync(parked, dir) } catch {}
  }
}
