import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { productionGateFailures } from "./lib.mjs";

// Fails closed: if GitHub's protections cannot be read, or any protection is missing, nothing is deployed.
export async function verifyProductionGate(env = process.env) {
  assert.ok(env.GH_TOKEN && env.GH_REPOSITORY, "GitHub token and repository are required");
  assert.match(env.GH_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${env.GH_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`Cannot verify production protection (${response.status}); refusing deployment`);
    return response.json();
  };
  const failures = await productionGateFailures(get);
  if (failures.length) throw new Error(`Production gate failed: ${failures.join("; ")}`);
  console.info("Production reviewer, main-only deployment, and branch protection gates verified.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await verifyProductionGate();
}
