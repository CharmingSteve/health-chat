import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { templateDefault } from "./lib.mjs";
import { ensureBucket } from "./ensure-bucket.mjs";

// Usage: node scripts/deploy.mjs staging|production   (run from the repo root, with AWS_PROFILE/creds set)
const environment = process.argv[2];
assert.ok(["staging", "production"].includes(environment), "Choose staging or production");
assert.equal(process.env.AWS_REGION, "us-east-1", "Deployment region must be us-east-1");
assert.match(process.env.BUILD_REVISION ?? "", /^[a-f0-9]{40}$/, "BUILD_REVISION must be a full commit SHA");

const ACCOUNT = "570989156105";
const stack = `health-chat-${environment}`;
const auth = `${stack}-auth`;
const artifactsStack = "health-chat-artifacts";
// The app shares the stuntman-diet user pool (same login). Its auth stack owns the pool.
const sharedAuth = `stuntman-diet-${environment}-auth`;

function aws(...args) {
  return execFileSync("aws", args, { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" } });
}

function outputs(name) {
  return Object.fromEntries(
    JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", name, "--output", "json")).Stacks[0].Outputs.map(
      ({ OutputKey, OutputValue }) => [OutputKey, OutputValue],
    ),
  );
}

function deploy(template, name, parameters = [], iam = false) {
  aws(
    "cloudformation", "deploy", "--template-file", template, "--stack-name", name,
    "--no-fail-on-empty-changeset", ...(iam ? ["--capabilities", "CAPABILITY_IAM"] : []),
    ...(parameters.length ? ["--parameter-overrides", ...parameters] : []),
  );
  console.info(`CloudFormation complete: ${name}`);
}

// Preflight: right account, and the shared pool stack must exist before anything else changes.
assert.equal(JSON.parse(aws("sts", "get-caller-identity", "--output", "json")).Account, ACCOUNT, "Wrong AWS account");
const shared = outputs(sharedAuth);
assert.ok(shared.CognitoUserPool && shared.CognitoDomain, `${sharedAuth} must export the shared pool and domain`);

const stacks = JSON.parse(
  aws("cloudformation", "list-stacks", "--stack-status-filter", "CREATE_COMPLETE", "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE", "--output", "json"),
).StackSummaries;
// First deploy uses a localhost callback. Later deploys point it at this app's own endpoint.
const callback = stacks.some(({ StackName }) => StackName === stack)
  ? `${outputs(stack).WebFunctionUrl}/`
  : "http://localhost:3000/";

// Table definitions (Glue) and the read-only Athena workgroup. Same in both environments; only production may read them.
const TABLES_BUCKET = "health-chat-tables-570989156105-us-east-1-an";
// Chat history. Never expires: no lifecycle rules are set on this bucket.
const LOGS_BUCKET = "health-chat-logs-570989156105-us-east-1-an";
ensureBucket(LOGS_BUCKET);
deploy("infra/data.yaml", "health-chat-data", [`TablesBucket=${TABLES_BUCKET}`]);

deploy("infra/artifacts.yaml", artifactsStack);
const artifacts = outputs(artifactsStack);
const key = `releases/${process.env.BUILD_REVISION}.zip`;
aws("s3", "cp", "dist/health-chat.zip", `s3://${artifacts.ArtifactBucketName}/${key}`, "--sse", "AES256", "--only-show-errors");

deploy("infra/auth.yaml", auth, [`UserPoolId=${shared.CognitoUserPool}`, `CallbackUrl=${callback}`]);
const authentication = outputs(auth);

deploy(
  "infra/template.yaml",
  stack,
  [
    `CodeBucket=${artifacts.ArtifactBucketName}`,
    `CodeKey=${key}`,
    `Environment=${environment}`,
    // Passed explicitly: CloudFormation reuses the previous value on update when a parameter is omitted.
    `BedrockModel=${templateDefault(readFileSync("infra/template.yaml", "utf8"), "BedrockModel")}`,
    `CognitoUserPool=${shared.CognitoUserPool}`,
    `CognitoDomain=${shared.CognitoDomain}`,
    `CognitoClientId=${authentication.HealthClientId}`,
    `SmokeClientId=${authentication.SmokeClientId}`,
    `DataEnabled=${environment === "production" ? "true" : "false"}`,
    `TablesBucket=${TABLES_BUCKET}`,
    `LogsBucket=${LOGS_BUCKET}`,
  ],
  true,
);

// Now that the endpoint exists, point the browser client's callback at it.
deploy("infra/auth.yaml", auth, [`UserPoolId=${shared.CognitoUserPool}`, `CallbackUrl=${outputs(stack).WebFunctionUrl}/`]);
console.info(`Endpoint: ${outputs(stack).WebFunctionUrl}`);
