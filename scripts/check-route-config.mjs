// scripts/check-route-config.mjs
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const routesFile = path.join(repoRoot, "app", "routes.ts");

if (!fs.existsSync(routesFile)) {
  console.error(`[check:routes] Missing ${routesFile}`);
  process.exit(1);
}

const txt = fs.readFileSync(routesFile, "utf8");
const re = /file:\s*["']([^"']+)["']/g;

const files = [];
let m;
while ((m = re.exec(txt)) !== null) files.push(m[1]);

if (!files.length) {
  console.error("[check:routes] No route files found in app/routes.ts (regex scan).");
  process.exit(1);
}

const missing = [];
for (const f of files) {
  const abs = path.join(repoRoot, "app", f);
  if (!fs.existsSync(abs)) missing.push({ file: f, abs });
}

if (missing.length) {
  console.error("[check:routes] Missing route modules referenced by app/routes.ts:");
  for (const x of missing) console.error(`  - ${x.file} (${x.abs})`);
  process.exit(1);
}

console.log(`[check:routes] OK (${files.length} route modules exist).`);
