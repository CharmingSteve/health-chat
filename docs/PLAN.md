# health-chat plan (revision 4, 2026-11-16)

## Readiness

**Not production-ready for health data yet.** Nothing is built or deployed. Repo and secrets exist.

Blocking items before real health data is loaded:

1. Model bake-off passes (see "Model").
2. Staging passes: deploy, Cognito smoke tests, and a sign-in with your real login.
3. Mutation check passes (see "Tests").
4. Ingest reads only the allowlist, and you have reviewed the allowlist.
5. GitHub `production` environment has a required reviewer, main-only branches, and branch protection.
6. AWS Budgets alert on account 570989156105.
7. You decide what to do with the non-data files in the medical bucket (see "Medical bucket").

## Purpose

A private assistant that helps you learn from your own data and investigate questions about it:

- **Trends and comparisons:** weight, steps, sleep, calories, and lab values over time.
- **Relationships:** for example, calories against weight, or steps against resting heart rate. These are
  shown as correlations with the number of data points, not as cause and effect.
- **Abnormal labs:** values outside the reference range, with dates and previous results.
- **Timelines:** what happened around a given date, from labs, diet, activity, and documents.
- **Gaps:** tests that haven't been repeated, days with missing data, and sources that stopped updating.
- **Investigation guides:** step-by-step instructions for checking a question yourself, in the web page.

### Priority questions (first eval set)

- **Blood markers over time:** HbA1c ("HEMOGLOBIN A1C %", 15 exports), total cholesterol, LDL, HDL, non-HDL,
  and triglycerides (15–16 exports each), glucose (17), creatinine and urea.
- **Weight:** from Apple Health, not blood tests. Compared with calories from the diet log.
- **Sodium and potassium:** blood electrolytes only (sodium and potassium appear in 19 exports, and the
  hospital PDF). See "Sodium" below.

### Sodium (important: not tracked in diet)

- The diet log records calories, not salt. Salt from the soup-mix-plus-teaspoon routine is **not** in any
  dataset, so sodium **intake** cannot be measured from your data.
- The app will only use blood sodium and potassium from `lab_results`, with dates and reference ranges.
- Every sodium answer must say: "Sodium intake is not recorded; this shows blood sodium only."
- No salt-intake field, no estimate of salt intake, and no correlation between calories and sodium.
  Hospital sodium values are included as dated lab results, with the admission noted
  as context from the document.

Non-goals for v1: diagnosis, treatment advice, sharing with anyone, and art or print output.
Exports exist only as plain CSV and PNG of a chart or table.

## Scope and constraints

- AWS account 570989156105, region us-east-1, profile `click` only.
- Lambda Web Functions run **Node.js only** (`nodejs24.x`). The app is TypeScript.
- The Web Function URL is the endpoint. No CloudFront, no API Gateway.
- Login is the same as stuntman-diet: the existing Cognito user pool, with JWT checks in the app.
- Low budget: no DynamoDB in this app, one Bedrock model, AWS-managed encryption only.

## Model

- **Chosen:** `us.amazon.nova-2-lite-v1:0`, the same as stuntman-diet. Price from the AWS Price List API,
  us-east-1, cross-region: $0.30 per 1M input tokens and $2.50 per 1M output tokens.
- **Caveat from my own test:** on one Hebrew page, `amazon.nova-lite-v1:0` read the text noticeably better
  than Nova 2 Lite, which produced garbled Hebrew. One page is not enough evidence. The bake-off on real lab
  documents decides. Switching is one line (see "Model setting").
- **Claude:** `anthropic.claude-haiku-5-5` returns AccessDenied for this account. Not an option until
  model access is granted.
- Details and sources: `docs/MODEL-EVAL.md`.

### Model setting (one place)

- `infra/template.yaml`: parameter `BedrockModel` with its default. This is the only place to change it.
- `scripts/deploy.mjs` reads that default, so staging and production always match.
- `.env.example` shows the same value for local runs.
- The app reads `BEDROCK_MODEL` from its environment, which CloudFormation sets from the parameter.

## Secrets and encryption

- **GitHub secrets:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set in `CharmingSteve/health-chat`,
  from the `click` profile. Values were never printed.
- **KMS:** AWS-managed keys only (`aws/s3`, `aws/logs`, or SSE-S3 where AWS-managed keys don't apply).
  No customer-managed keys, so no monthly key charge.
- **No secrets in the app:** the app has no API keys. Cognito and Bedrock use the Lambda execution role.

## Ingest allowlist

- Ingest reads only an explicit allowlist of paths. Anything not on the list is not read.
  Folders that belong to other people are not on the list.
- Every row gets an `owner` value from its allowlist entry.
- The allowlist is the control. There are no search-based tests for file names.

## Medical bucket (checked 2026-11-16)

Bucket `medical-stuff-570989156105-us-east-1-an`, 3,777 objects:

- 1,878 files with no extension (DICOM X-ray images), 1,767 JPG/PNG, 41 PDF, 6 CSV, 5 `.DS_Store`.
- **59 files are not data:** Windows installers and viewer programs (`.msi`, `.exe`, `.dll`, `.ini`, `.inf`,
  `.bmp`, `.obj`, `.cfg`) under the shoulder and foot X-ray folders.
  Ingest skips them by allowlist. Deleting them from the bucket is your call; nothing has been deleted.
- **Physiotherapy folder:** physiotherapy referrals and receipts are health-related and will be
  ingested. A few JPGs in it are DALL·E "IT outage" images, not health data. Exclude by file name? Your call.

## Ingest (new data arrives regularly)

| Source | How it grows | Ingest rule |
|---|---|---|
| Daily diet | stuntman-diet exports a snapshot nightly at 03:00 Asia/Jerusalem to its puddle bucket | Read the newest published export. Each run replaces the diet tables for that snapshot. One snapshot is queried at a time. |
| Apple Watch | You export from the iPhone (`export.xml` is cumulative) and upload to the apple-health bucket | Dedupe by the natural key (type, start, end, source, value). Re-running adds no duplicates. |
| Periodic medical | You upload Clalit exports, hospital PDFs, and scans | Each file is recorded by S3 key and ETag. New or changed files are extracted once. Unchanged files are skipped. |

- One command: `npm run ingest`. It prints what it added and what it skipped.
- An ingest ledger (Parquet) records each source key, ETag, and status. Re-running with no new files changes nothing.
- Later, an S3 upload event can trigger ingest automatically. Not in the first version.

## Symptom and context journal (new source)

Blood tests are one-day snapshots, so they can't show what happened on the days you had cramps or headaches.
A journal records the context that the other sources miss:

- **Symptoms:** cramps (which muscles, when, severity 0–10), headache (severity, time, and whether it came after training).
- **Salt:** teaspoons of added salt per day, plus the soup mix used (with its sodium from the label, once you enter it).
- **Magnesium:** product, dose, and time taken.
- **Water:** litres per day, as an estimate.
- **Exercise notes:** free text, such as "long run in heat", linked to Apple Health workouts by date.

Entries can be made three ways: a web form, a chat message ("cramps in calves, 6/10, 1 tsp salt, magnesium 400 mg"),
or an import. The chat message is parsed into fields, and the app shows the parsed entry for you to confirm before saving.
Nothing is saved until you confirm.

### Blank is not zero

- The app never scores you for missing entries: no streaks, no points, no reminders you can't switch off.
- A day with no entry is **unknown**, not "no cramps". Answers never count blank days as symptom-free.
- To record a symptom-free day, there is an explicit "no symptoms today" button, saved as a real entry.
- Trend answers state how many days were logged out of the period, for example "cramps recorded on 4 of 21 logged days; 9 days not logged".

### What the journal can answer

- "On days with calf cramps, how long were my workouts and how much salt and water did I log?"
- "Headaches: what came before them in the 24 hours before (workout length, salt, water, magnesium)?"
- "Between the blood tests, what did my days look like?" (The journal is the only context for the days in between.)

Every answer says: the journal is self-reported and incomplete. Salt and water are estimates. The sample size is
the number of logged days.

### Salt conversion (estimate, stated in the app)

One level teaspoon of table salt contains about 2,300 mg sodium. Soup mixes are different. Their sodium comes from
the label, which you enter once per product. The app shows the conversion and uses the stated constant. A test checks
the constant (2,300 mg per teaspoon) so it can't drift.

### Safety rules (built into the chat)

- Cramps and headaches are normal exercise complaints, but a past admission for **low blood sodium** means
  the app treats low-sodium history as relevant. The app notes that drinking large amounts of plain water while
  sweating can also lower sodium. It does not tell you how much to drink.
- Magnesium and potassium: kidney function has been low in past results. The app flags that supplement doses
  and potassium should be checked with a doctor. It gives no dosing advice.
- Urgent symptoms: severe or sudden headache, confusion, vomiting, fainting, or chest pain. The app says to seek
  urgent care, and does not analyse those episodes as trends.
- Doctor questions: the app can draft a list of questions for your doctor, built from your data and labelled as
  drafts, not advice.

### Tests for this source

- Parsed chat entries match the expected fields for a fixed set of example messages. Unclear fields are asked
  for, not guessed.
- Nothing is saved without confirmation.
- The salt constant is 2,300 mg per teaspoon.
- An urgent-symptom message gets the urgent response, not a trend analysis.

## Data model

- Parquet tables in a private, encrypted, versioned S3 bucket. Glue catalog. Athena workgroup with a
  100 MiB per-query scan cap (copied from stuntman).
- Tables: `lab_results`, `apple_daily`, `apple_workouts`, `diet_daily`, `documents`, `journal_entries`, and the ingest ledger.
- Every row has an `owner` column. Analytics queries filter by it.
- Extracted lab values keep their source file and page, so every number can be traced.
- **Clalit exports** are text lines: `NAME, unit, result, low, high`, with a header block holding the test date.
  Some names vary between exports (for example `CHOLESTEROL- HDL` and `CHOLESTEROL/ HDL`, or `ALT (GPT)` and
  `ALT(GPT)`). A normalization table maps each variant to one test name. Unknown names are reported, not dropped.
- Sample-quality flags (`LIPEMIC`, `ICTERIC`, `HEMOLYTIC`) are stored as flags, not as test values.
- Hospital PDFs (for example an admission summary) are extracted once and tagged with their page.
- Weight, steps, and calories come from Apple Health and the diet snapshot, not from `lab_results`.

## Chat app

- Bedrock Converse API with tool use. Model from `BEDROCK_MODEL`.
- Tools:
  - `query_data(sql)`: SELECT only, approved tables only, scan cap. Returns the SQL with the answer.
  - `search_docs(text)`: keyword search over `documents`. No vector database at this budget.
  - `make_chart(sql, kind)`: a simple line, bar, or scatter chart from a query result, shown in the page.
- Every answer shows the SQL or the document and page it came from.
- Relationship answers state the sample size and say they are correlations.
- A medical disclaimer is shown in the UI. Urgent-looking values are flagged for a doctor.
- Logs: request counts and errors only. No health content in logs.

## Investigation guides (web page)

The page uses `<details>` dropdowns, like stuntman-diet's page. Sections:

- **What you can ask,** with examples in each category above.
- **How an answer is made:** SQL over tables, document search, and where each figure came from.
- **How to check an answer yourself:** open the SQL, rerun it, and compare with the source file page.
- **How to read a trend:** sample size, gaps in the data, and the difference between a trend and a single day.
- **How to read a correlation:** what it does and doesn't show (no cause, small samples, confounding).
- **How to read a lab value:** units, reference ranges, and why the lab's range may differ from others.
- **Data quality:** which sources are current, which days are missing, and what a missing day means.
- **Adding data:** the diet snapshot, Apple Watch export steps, and medical upload steps.
- **What is not used:** no data outside the allowlist.
- **Model in use** and where it is set (display only).
- **Disclaimer:** not medical advice. Contact a doctor for urgent values.

## Exports

- Any chart or table can be downloaded as CSV, or a chart as PNG.
- Exports strip any DICOM header fields that contain names or IDs, and the file name is not used.
- Nothing is sent to an outside service.

## Tests (must be able to fail)

The rule: every test checks a value calculated by hand from a fixture, never a value copied from the code's output.
A test that can't fail is a bug in the test.

- **Specific expectations:** tests assert exact values, with the calculation in a comment. No bare `toBeTruthy()`.
- **No skips in CI:** CI fails if any test is `skip`, `todo`, or `only`.
- **Mutation check (`scripts/mutation-check.mjs`):** CI applies deliberate bugs one at a time and requires the
  suite to fail each time. Bugs include: allow a non-allowlisted path into ingest, drop the owner value,
  allow `DELETE` in the SQL guard, skip dedupe on Apple records, re-extract unchanged files, drop the ledger
  check, accept a token with the wrong audience, and return 200 for an unauthenticated route.
- **Correlation tests:** a fixture where the correlation is known by hand, and one with a known zero.
- **Sodium rule test:** any answer that mentions sodium contains the "blood sodium only" statement. A sodium
  question that asks about salt intake must be refused, not estimated.
- **Name normalization test:** each known Clalit name variant maps to one test name, and an unknown name is reported.
- **Eval:** gold questions with answers from the hospital PDFs and lab exports. Stored outside git.
  Run before any model change.
- **Deploy scripts:** `node --test` for the gate and export deadline logic, copied from stuntman.

## Smoke tests (Cognito, same pattern as stuntman)

1. `GET /health` returns 200.
2. A protected route with no token returns 401.
3. The smoke client gets a token with scope `health-smoke/query` and calls `POST /api/smoke`. That route sends a
   fixed prompt to Bedrock and checks the reply. It touches no health data.
4. The smoke token is rejected on every other route (403).

Staging and production both run these. Production never runs fixtures.

## Login

- stuntman-diet's `infra/auth.yaml` owns the user pool. **Do not change it.**
- health-chat's `infra/auth.yaml` takes the existing pool ID as a parameter. It creates:
  - a browser app client with its own callback URL (your login stays the same);
  - a resource server `health-smoke` with scope `query`;
  - a `client_credentials` smoke client that has only that scope.
- Staging uses the staging pool, production uses the production pool.

## Repo layout (mirrors stuntman-diet)

```
health-chat/
  src/            Hono app, auth, tools (query_data, search_docs, make_chart), Bedrock Converse loop
  src/ingest/     allowlist, sources, extraction, Parquet writer, ledger
  public/         web page with <details> guidance
  tests/          Vitest: auth, SQL guard, allowlist, owner, ledger, parsers, correlations, mutation list
  scripts/        deploy.mjs, cloud-smoke.mjs, check-deployment.mjs, verify-production-gate.mjs, mutation-check.mjs
  infra/          artifacts.yaml, auth.yaml (app and smoke clients), template.yaml (Web Function, S3, Athena, Glue)
  docs/           PLAN.md, MODEL-EVAL.md
  .github/workflows/ci.yml
```

## Deployment (copied from stuntman-diet)

- Stacks: `health-chat-staging` and `health-chat-production`, each with an auth stack, plus an artifacts stack.
  Releases go to `releases/<commit SHA>.zip`.
- Web Function: `AWS::Lambda::WebFunction`, `WebFunctionRevision` (`nodejs24.x`, timeout 60 s,
  `MaxConcurrencyPerEnvironment` 8), `WebFunctionEndpoint` (`HomeRegion`, `ApplicationManaged`, `MaxEnvironments` 2).
- Preflight (read-only) and post-deploy checks: `check-deployment.mjs`.
- Template checks: `cfn-lint`, `checkov` (document any exceptions), `actionlint`, `zizmor`.

## CI/CD (copied from stuntman-diet)

- **Pull requests:** tests, mutation check, TypeScript build, Linux ZIP packaging. No deploy.
- **Push to `main`:** deploy staging, then smoke tests.
- **Production:** manual approval through the `production` environment. `verify-production-gate.mjs` fails
  closed if reviewers, main-only branches, or branch protection are missing.
- **You do:** approve the production deploy in GitHub. Nothing else is manual after staging passes.

## Budget

- Web Function: small (max 2 environments).
- Athena: cents per query, with a 100 MiB scan cap.
- S3: a few GB.
- Cognito: free tier.
- Bedrock: the variable cost. Measure during the bake-off and staging.
- AWS Budgets alert at $5 per month.

These are targets, not measured numbers.

## Phases

1. **Local app:** Node 24 (via `npx node@24`, so the broken system Node isn't changed), TypeScript, Vitest, Hono.
2. **Ingest and tests:** allowlist, owner values, the three sources, ledger, dedupe, mutation check.
3. **Bake-off:** extract the gold set with both Nova models. Pick the model.
4. **Athena and Glue:** tables and queries on fixtures.
5. **Core analysis:** `query_data`, trend and correlation helpers, abnormal-lab and gap checks, `search_docs`,
   `make_chart`, and the investigation guides on the page.
6. **Staging:** infra, deploy, Cognito smoke tests, and your sign-in.
7. **Production:** you approve the GitHub environment. Smoke tests run.

## Open decisions

1. Delete the 59 non-data files from the medical bucket? (Your call. Nothing is deleted without a yes.)
2. Exclude the DALL·E images in the physiotherapy folder?
3. Nova 2 Lite as planned, or switch to `amazon.nova-lite-v1:0` if the bake-off favors it?
