#!/usr/bin/env node
/**
 * Cross-platform Prisma "apply schema" helper.
 *
 * - If prisma/migrations contains at least one migration folder with migration.sql:
 *     prisma migrate deploy
 * - Else:
 *     prisma db push
 *
 * Flags:
 *   --generate-only   Run prisma generate only
 *   --apply-only      Run schema apply only (migrate deploy OR db push)
 *   --skip-generate   Skip prisma generate (default is generate + apply)
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const generateOnly = args.has("--generate-only");
const applyOnly = args.has("--apply-only");
const skipGenerate = args.has("--skip-generate");

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function hasRealMigrations() {
  const migDir = resolve(ROOT, "prisma", "migrations");
  if (!existsSync(migDir)) return false;

  const entries = readdirSync(migDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const migrationSql = join(migDir, ent.name, "migration.sql");
    if (existsSync(migrationSql)) return true;
  }
  return false;
}

function prismaGenerate() {
  // Use npx so it works without global installs
  run("npx", ["prisma", "generate"]);
}

function prismaApply() {
  if (hasRealMigrations()) {
    console.log("==== Prisma apply: migrations found -> prisma migrate deploy ====");
    run("npx", ["prisma", "migrate", "deploy"]);
  } else {
    console.log("==== Prisma apply: no migrations -> prisma db push ====");
    run("npx", ["prisma", "db", "push"]);
  }
}

if (generateOnly) {
  prismaGenerate();
  process.exit(0);
}

if (applyOnly) {
  prismaApply();
  process.exit(0);
}

if (!skipGenerate) {
  prismaGenerate();
}
prismaApply();
