import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Usage: node scripts/cloud-smoke.mjs health-chat-staging|health-chat-production
// Cognito smoke: a client_credentials token with ONLY the health-smoke/query scope.
const stack = process.argv[2];
assert.match(stack ?? "", /^health-chat-(staging|production)$/);
const environment = stack.endsWith("-staging") ? "staging" : "production";
assert.equal(process.env.AWS_REGION, "us-east-1");

function aws(...args) {
  const output = execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, maxBuffer: 8 * 1024 * 1024,
  });
  return output.trim() ? JSON.parse(output) : {};
}
assert.equal(aws("sts", "get-caller-identity").Account, "570989156105", "Wrong AWS account");

function outputs(name) {
  return Object.fromEntries(
    aws("cloudformation", "describe-stacks", "--stack-name", name).Stacks[0].Outputs.map(
      ({ OutputKey, OutputValue }) => [OutputKey, OutputValue],
    ),
  );
}
const base = outputs(stack).WebFunctionUrl.replace(/\/$/, "");
const auth = outputs(`${stack}-auth`);
const shared = outputs(`stuntman-diet-${environment}-auth`);

async function request(path, { token, method = "GET" } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return fetch(`${base}${path}`, { method, headers });
}

// A cold Web Function can take a little while to start, so /health gets a short retry window.
async function waitForHealth() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await request("/health");
      if (response.status === 200) return response;
    } catch {
      // Still starting; retry below.
    }
    await sleep(3000);
  }
  throw new Error("/health did not return 200 within the retry window");
}

const health = await waitForHealth();
assert.deepEqual(await health.json(), { status: "ok" }, "health body");
console.info("PASS GET /health -> 200");

assert.equal((await request("/api/me")).status, 401, "protected route without a token");
console.info("PASS GET /api/me without token -> 401");

assert.equal((await request("/api/smoke", { method: "POST" })).status, 401, "model route without a token");
console.info("PASS POST /api/smoke without token -> 401");

// Smoke token: read the client secret from Cognito (the deploy identity can do this), never print it.
const secret = aws("cognito-idp", "describe-user-pool-client", "--user-pool-id", shared.CognitoUserPool,
  "--client-id", auth.SmokeClientId).UserPoolClient.ClientSecret;
assert.ok(secret, "smoke client secret");
const tokenResponse = await fetch(`${shared.CognitoDomain}/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${auth.SmokeClientId}:${secret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ grant_type: "client_credentials", scope: "health-smoke/query" }),
});
assert.equal(tokenResponse.status, 200, "Cognito client_credentials");
const { access_token: token } = await tokenResponse.json();
console.info("PASS Cognito client_credentials token for health-smoke/query");

const model = await request("/api/smoke", { method: "POST", token });
assert.equal(model.status, 200, "model check with smoke token");
assert.deepEqual(await model.json(), { ok: true, model: "configured" }, "model check body");
console.info("PASS POST /api/smoke with smoke token -> 200 (model replied 4)");

assert.equal((await request("/api/me", { token })).status, 403, "smoke token on a non-smoke route");
console.info("PASS GET /api/me with smoke token -> 403");
console.info(`Smoke checks passed for ${stack}.`);
