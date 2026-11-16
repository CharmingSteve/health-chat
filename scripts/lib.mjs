// Pure helpers shared by the deploy scripts and their tests. No AWS or network calls here.

/** Reads a parameter's Default from a CloudFormation template text, e.g. the BedrockModel setting. */
export function templateDefault(templateText, parameter) {
  const lines = templateText.split("\n");
  const start = lines.indexOf(`  ${parameter}:`);
  if (start < 0) throw new Error(`${parameter} parameter not found in template`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) break; // reached the next parameter without a Default
    const match = /^    Default: (\S+)$/.exec(lines[i]);
    if (match) return match[1];
  }
  throw new Error(`${parameter} has no Default in template`);
}

/**
 * Production gate: the production GitHub environment must have a reviewer, must allow only main,
 * and main must be protected. `get(path)` returns the parsed GitHub API response for a repo path,
 * or throws if the API call fails. Returns a list of failures (empty means the gate passes).
 */
export async function productionGateFailures(get) {
  const failures = [];
  const environment = await get("environments/production");
  const hasReviewers = (environment.protection_rules ?? []).some(
    (rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0,
  );
  if (!hasReviewers) failures.push("production environment has no required reviewers");
  if (environment.deployment_branch_policy?.custom_branch_policies !== true) {
    failures.push("production deployment is not restricted to explicit branch policies");
  }
  const policies = await get("environments/production/deployment-branch-policies");
  const branchPolicies = policies.branch_policies ?? [];
  if (branchPolicies.length === 0 || !branchPolicies.every((p) => p.name === "main" && p.type === "branch")) {
    failures.push("production deployment policies must allow only the main branch");
  }
  const main = await get("branches/main");
  if (main.protected !== true) failures.push("main branch protection is not enabled");
  return failures;
}
