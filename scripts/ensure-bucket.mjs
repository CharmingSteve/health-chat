import { execFileSync } from "node:child_process";

// CloudFormation cannot create account-regional namespace buckets yet, so buckets are created here.
// Idempotent: creates the bucket if missing, then sets the same protections on every run.
// Settings: private, AWS-managed encryption, versioned, and no lifecycle rules (nothing expires).
export function ensureBucket(name, region = "us-east-1") {
  const aws = (...args) => execFileSync("aws", [...args, "--region", region], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let exists = true;
  try {
    aws("s3api", "head-bucket", "--bucket", name);
  } catch (error) {
    if (!/404|Not Found/.test(String(error.stderr))) throw error;
    exists = false;
  }
  if (!exists) aws("s3api", "create-bucket", "--bucket", name, "--bucket-namespace", "account-regional");
  aws("s3api", "put-public-access-block", "--bucket", name, "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true");
  aws("s3api", "put-bucket-encryption", "--bucket", name, "--server-side-encryption-configuration",
    JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] }));
  aws("s3api", "put-bucket-versioning", "--bucket", name, "--versioning-configuration", "Status=Enabled");
  return exists ? "exists" : "created";
}
