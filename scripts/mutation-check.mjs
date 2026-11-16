import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Each mutation plants one deliberate bug. The test suite MUST fail for every one.
// If a planted bug survives, the tests cannot be trusted and this script exits 1.
const root = resolve(import.meta.dirname, "..");
const mutations = [
  { name: "accept any token_use", file: "src/auth.ts",
    from: 'if (payload.token_use !== "access" && payload.token_use !== "id") {', to: "if (false) {" },
  { name: "skip smoke scope check", file: "src/auth.ts",
    from: 'if (!scopes.includes("health-smoke/query")) {', to: "if (false) {" },
  { name: "skip app client check", file: "src/auth.ts",
    from: "(payload.token_use === \"access\" && payload.client_id !== config.clientId)", to: "false" },
  { name: "let smoke token reach any route", file: "src/app.ts",
    from: 'if (isSmoke && !(c.req.method === "POST" && c.req.path === "/api/smoke")) {', to: "if (false) {" },
  { name: "drop auth on /api", file: "src/app.ts",
    from: 'app.use("/api/*", requireAuth);', to: "" },
  { name: "loose model reply check", file: "src/bedrock.ts",
    from: 'return reply.trim() === "4";', to: 'return reply.includes("4");' },
];

const failures = [];
for (const mutation of mutations) {
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    failures.push(`${mutation.name}: target text found ${occurrences} times (expected 1); update the mutation list`);
    continue;
  }
  const backup = resolve(root, ".mutation-backup.ts");
  copyFileSync(path, backup);
  try {
    writeFileSync(path, original.replace(mutation.from, mutation.to));
    const run = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run"], { cwd: root, encoding: "utf8" });
    if (run.status === 0) failures.push(`${mutation.name}: tests PASSED with the bug planted (survivor)`);
    else console.info(`killed: ${mutation.name}`);
  } finally {
    copyFileSync(backup, path);
    rmSync(backup);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.info(`All ${mutations.length} planted bugs were caught by the tests.`);
