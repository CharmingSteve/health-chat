import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { productionGateFailures, templateDefault } from "../scripts/lib.mjs";

const template = readFileSync(resolve(import.meta.dirname, "..", "infra", "template.yaml"), "utf8");

test("deploy reads the BedrockModel default from the template", () => {
  assert.equal(templateDefault(template, "BedrockModel"), "us.amazon.nova-2-lite-v1:0");
});

test("a parameter without a Default is reported, not guessed", () => {
  assert.throws(() => templateDefault("Parameters:\n  Foo:\n    Type: String\nResources:\n", "Foo"), /no Default/);
  assert.throws(() => templateDefault(template, "NoSuchParameter"), /not found/);
});

const goodGet = async (path) => {
  if (path === "environments/production") {
    return { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
      deployment_branch_policy: { custom_branch_policies: true } };
  }
  if (path === "environments/production/deployment-branch-policies") {
    return { branch_policies: [{ name: "main", type: "branch" }] };
  }
  if (path === "branches/main") return { protected: true };
  throw new Error(`unexpected ${path}`);
};

test("the production gate passes when reviewers, main-only policy, and protection are all set", async () => {
  assert.deepEqual(await productionGateFailures(goodGet), []);
});

test("the production gate fails when there is no reviewer", async () => {
  const get = async (path) => path === "environments/production"
    ? { protection_rules: [], deployment_branch_policy: { custom_branch_policies: true } }
    : goodGet(path);
  assert.deepEqual(await productionGateFailures(get), ["production environment has no required reviewers"]);
});

test("the production gate fails when a non-main branch may deploy", async () => {
  const get = async (path) => path === "environments/production/deployment-branch-policies"
    ? { branch_policies: [{ name: "main", type: "branch" }, { name: "feature", type: "branch" }] }
    : goodGet(path);
  assert.deepEqual(await productionGateFailures(get), ["production deployment policies must allow only the main branch"]);
});

test("the production gate fails when main is not protected", async () => {
  const get = async (path) => path === "branches/main" ? { protected: false } : goodGet(path);
  assert.deepEqual(await productionGateFailures(get), ["main branch protection is not enabled"]);
});
