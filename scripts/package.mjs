import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Builds dist/health-chat.zip: production dependencies, compiled server, public pages, and the index.js entry.
// Web Functions start index.js, which imports dist/server.js. No native modules, so any OS can build it.
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist", "health-chat.zip");
const staging = mkdtempSync(resolve(root, ".package-"));
try {
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  for (const file of ["package.json", "package-lock.json"]) cpSync(resolve(root, file), resolve(staging, file));
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staging, stdio: "inherit" });
  cpSync(resolve(root, "dist"), resolve(staging, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".zip"),
  });
  cpSync(resolve(root, "public"), resolve(staging, "public"), { recursive: true });
  writeFileSync(resolve(staging, "index.js"), 'import "./dist/server.js";\n', { mode: 0o644 });
  execFileSync("zip", ["-q", "-r", output, "."], { cwd: staging, stdio: "inherit" });
  console.info(`Created ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
