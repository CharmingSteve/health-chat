import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { verifyCognitoToken } from "./auth.js";
import { createConverse } from "./bedrock.js";
import { createApp } from "./app.js";
import { makeAsk } from "./ask.js";
import { createChatModel } from "./bedrock.js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

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

// Data questions run only where DATA_ENABLED=true (production). Staging has no access to the tables.
const dataEnabled = process.env.DATA_ENABLED === "true";
const modelId = required("BEDROCK_MODEL");
const ask = dataEnabled
  ? makeAsk({ modelId, workgroup: required("ATHENA_WORKGROUP"), database: required("GLUE_DATABASE") })
  : undefined;

// Diet import status and refresh (production only). The job itself runs in its own Lambda.
const tablesBucket = process.env.TABLES_BUCKET;
const dietJob = process.env.DIET_JOB_NAME;
const diet = dataEnabled && tablesBucket && dietJob
  ? {
      readStatus: async () => {
        const s3 = new S3Client({});
        const read = async (key: string) => {
          try {
            const r = await s3.send(new GetObjectCommand({ Bucket: tablesBucket, Key: key }));
            return JSON.parse(await r.Body!.transformToString("utf8")) as unknown;
          } catch (error) {
            if (error instanceof Error && error.name === "NoSuchKey") return null;
            throw error;
          }
        };
        return { last_success: await read("ledger/diet.json"), last_attempt: await read("ledger/diet-status.json") };
      },
      startRefresh: async () => {
        const lambda = new LambdaClient({});
        await lambda.send(new InvokeCommand({ FunctionName: dietJob, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ trigger: "manual" })) }));
      },
    }
  : undefined;

// Chat history is written straight to S3, in the same environments that can read data.
const logsBucket = process.env.LOGS_BUCKET;
const history = dataEnabled && logsBucket
  ? { s3: new S3Client({}), bucket: logsBucket, now: () => new Date(), model: modelId }
  : undefined;

const app = createApp({
  verify: (token) => verifyCognitoToken(token, { userPool, clientId, ...(smokeClientId ? { smokeClientId } : {}) }),
  clientId,
  ...(smokeClientId ? { smokeClientId } : {}),
  converse: createConverse(modelId),
  ...(ask ? { ask } : {}),
  ...(history ? { history } : {}),
  ...(diet ? { diet } : {}),
  browserConfig: { domain: cognitoDomain, clientId },
  publicDir: resolve(import.meta.dirname, "..", "public"),
});

serve({ fetch: app.fetch, ...listenAddress() }, (info) => {
  console.info(`health-chat listening on ${info.address}:${info.port}`);
});
