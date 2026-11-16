import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { verifyCognitoToken } from "./auth.js";
import { createConverse } from "./bedrock.js";
import { createApp } from "./app.js";

// Web Functions give the server its host and port in AWS_LAMBDA_HTTP_ENDPOINT (host:port).
// Locally the fallback is used.
function listenAddress(): { hostname: string; port: number } {
  const raw = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000";
  const [hostname, port] = raw.split(":");
  if (!hostname || !port) throw new Error("AWS_LAMBDA_HTTP_ENDPOINT must be host:port");
  return { hostname, port: Number(port) };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

const userPool = required("COGNITO_USER_POOL");
const clientId = required("COGNITO_CLIENT_ID");
const smokeClientId = process.env.SMOKE_CLIENT_ID || undefined;
const cognitoDomain = required("COGNITO_DOMAIN");

const app = createApp({
  verify: (token) => verifyCognitoToken(token, { userPool, clientId, ...(smokeClientId ? { smokeClientId } : {}) }),
  clientId,
  ...(smokeClientId ? { smokeClientId } : {}),
  converse: createConverse(required("BEDROCK_MODEL")),
  browserConfig: { domain: cognitoDomain, clientId },
  publicDir: resolve(import.meta.dirname, "..", "public"),
});

serve({ fetch: app.fetch, ...listenAddress() }, (info) => {
  console.info(`health-chat listening on ${info.address}:${info.port}`);
});
