# health-chat

A private assistant for your own health data. It runs as an AWS Lambda Web Function (Node.js 24), behind Cognito sign-in.

**Working now:** sign-in, the question box (answers from SQL over your tables, with the queries shown), the model check, the guide page, the deploy pipeline, and smoke tests. Production only reads your data; staging never does.
**Imported:** diet, Apple Health (records, workouts, routes, ECG), lab results, and medical document text.
**Not built yet:** charts; OCR or vision reading of scanned PDFs and images; de-duplication of Apple Health sources. See [docs/PLAN.md](docs/PLAN.md).

## Asking questions

1. Sign in, type a question in "Ask about your data", and press Ask.
2. The model writes SQL. The app checks it before running it: one SELECT statement, approved tables only, no comments, at most 500 rows.
3. The answer is shown with the queries it ran. You can rerun any of them in Athena to check the numbers.

What the chat does not do: it does not change data, it does not read the raw files, and it does not give medical advice. Blank days are unknown, not zero. Sodium answers mean blood sodium only.

Model and query settings: `BedrockModel` in `infra/template.yaml` (model), `DataEnabled` (production only), and the workgroup limit of 1 GiB scanned per query in `infra/data.yaml`.

To try a question from your machine, without the browser: `AWS_PROFILE=click AWS_REGION=us-east-1 npx tsx scripts/ask-local.ts "your question"`.

## Terms used here

- **Upload**: copying a file into an S3 bucket. Nothing is read or changed.
- **Import** (`npm run ingest:diet`, `npm run ingest:apple`): reading the source files, checking them, and writing Parquet tables.
  Import never changes a source file. It stops with an error on any row it cannot read, rather than guessing.
  It can be run again: the sources are read again and the tables are replaced.
- **Table**: a Parquet file with a fixed schema, stored in the tables bucket.
- **Ledger**: a JSON file next to each table set, listing which source files and ETags were read, and the row counts.

## Where data lives

| What | Where | Kept until |
|---|---|---|
| Apple Health export (XML, GPX routes, ECG) | `apple-health-570989156105-us-east-1-an` (your upload, not changed) | you delete it |
| Medical documents and scans | `medical-stuff-570989156105-us-east-1-an` (your upload, not changed) | you delete it |
| Diet: legacy master CSV | `health-chat-diet-570989156105-us-east-1-an/legacy-master/` | you delete it |
| Diet: stuntman-diet nightly export and results | `health-chat-diet-570989156105-us-east-1-an/stuntman-production/` | you delete it |
| Derived tables | `health-chat-tables-570989156105-us-east-1-an/diet/` and `apple/` | replaced on each import |
| Ledgers | `health-chat-tables-570989156105-us-east-1-an/ledger/` | replaced on each import |
| Athena query results | `health-chat-tables-570989156105-us-east-1-an/athena-results/` | 7 days |

Retention rules on the tables bucket: old table versions are deleted after 30 days; Athena results after 7 days.
Every bucket is private, versioned, encrypted with AWS-managed keys, and blocks public access.

## Chat history

Every question and answer is saved in `health-chat-logs-570989156105-us-east-1-an`, written directly by the app (no proxy).

- **What is kept:** each turn is one object: question, answer, the SQL run, and the result rows (up to 500 per query), with the time and the model. Layout: `chats/<chat id>/<time>_<turn id>.json`. A small `activity/<chat id>.json` holds each chat's subject and last time, and is overwritten per turn.
- **Never deleted:** the app has no delete permission on this bucket, the bucket keeps every version, and it has no lifecycle rules.
- **Saving:** the answer is shown straight away. The server retries the save four times (about 12 seconds). If that fails, the page resends the turn every 15 seconds for about five minutes. If it still fails, the turn is kept in this browser and resent the next time you open the page. Until it is saved, a banner says so.
- **The list:** "Chats from the last 4 months" shows chats whose last question is within 120 days. An older chat drops off the list when it has not been used for 4 months, but it stays in the bucket and reopens if you use it again.
- **Context for new questions:** the last six turns are sent with an excerpt of each answer, and earlier questions in the same chat are listed by text. The total is capped at 6,000 characters. Earlier answers are labelled as possibly out of date, so the model re-runs SQL for figures.
- **Where it is enabled:** production only. Staging has no history.
- `scripts/ask-local.ts` does not save history; it is for checks only.

Health content is in these records, so treat the bucket like the others: private, with no public access.

## Setup and commands

Requirements: Node.js 24, AWS CLI v2, the `click` profile.

```bash
export AWS_PROFILE=click AWS_REGION=us-east-1
npm ci
npm test                       # unit tests (Vitest) and deploy-logic tests (node:test)
npm run mutation               # plants known bugs and fails if the tests miss any
npm run ingest:diet     # import diet data into the tables bucket
npm run ingest:apple    # import Apple Health (reads ~1.6 GiB; takes a while)
npm run ingest:medical  # import lab results, medical PDF text, and the image index
npm run dev                    # local server on http://localhost:3000
```

Deployment is done by CI. Push to `main`: CI tests, packages, deploys staging, runs smoke tests, then waits for approval before production.

## What import does, by source

**Lab results and medical documents** (`npm run ingest:medical`)
- Reads only the allowlisted folders and the top-level PDFs. Anything else in the bucket is skipped and counted in the ledger with its reason.
- Clalit exports: one row per result, with its date, unit, value, reference range, and a flag (low, high, in range). Test names are normalized (see `NAME_MAP` in `src/ingest/labs.ts`); names not yet mapped are kept as they are and listed in the ledger.
- Identical repeated results are counted and kept once.
- PDFs: the text layer is stored. Scanned PDFs without a text layer are marked `has_text=false` and are not read yet.
- Images and DICOM-candidate files are indexed by name, size, and date only.

**Diet**
- Reads the newest stuntman-diet export (by its manifest time), and the legacy master CSV.
- Dates in the legacy CSV are day-first (`01/05/2025` is 1 May 2025). Impossible dates are rejected.
- Superseded entries are kept and marked.
- Named exclusions are listed in code with their reason. Currently one: seven identical entries dated 5 January 2025.
- Output: `diet_entries`, `diet_days`.

**Apple Health**
- Reads the newest export folder. Streams `export.xml`, so the file never has to fit in memory.
- Keeps every record and every workout, of every type (walking, skating, CrossFit, and others).
- Workout statistics are stored as JSON. A workout's route link is stored as `route_file`.
- Reads each GPX route: start and end time, point count, and distance (summed between points).
- Reads each ECG recording: metadata and microvolt samples. The patient name and date of birth are not stored.
- Output: `apple_records`, `apple_workouts`, `apple_routes`, `apple_ecg_recordings`, `apple_ecg_samples`.

## Apple Health: read before totalling

The export contains records from every source (iPhone, Apple Watch, and third-party apps). Summing
them directly can count the same activity twice. Apple's Health app uses a single source for steps,
chosen by a priority order; the export does not apply that choice. Totals in this app are raw sums until
de-duplication is added. Sources: [Sahha: deduplicating health data across wearables](https://sahha.ai/blog/deduplicating-health-data-across-wearables/),
[Apple Developer Forums: recordCount in the exported XML](https://developer.apple.com/forums/thread/20345).

## Deployment, smoke tests, and the production gate

- Staging deploys on every push to `main`, then the Cognito smoke tests run.
- Production waits for approval in the `production` environment (required reviewer: the repo owner). It deploys only from `main`.
- Smoke tests check: `/health` returns 200; protected routes return 401 without a token; the smoke token can run the model check and is refused on other routes.

## Model

Used for the question box. Set in one place: the `BedrockModel` parameter default in `infra/template.yaml`
(currently `us.amazon.nova-2-lite-v1:0`). Deploy reads that default, so staging and production always match.

## Privacy

- Health data is not stored in this repo. `.gitignore` blocks data file types.
- Logs record counts and error types, not health content.
- This is not medical advice. Contact a doctor about urgent symptoms or values.

## Layout

```
src/            server (Hono), auth (Cognito JWT), Bedrock call
src/ingest/     import: diet, Apple Health, Parquet writing
public/         browser page: sign-in, model check, guide dropdowns
tests/          Vitest tests and node:test deploy tests
scripts/        deploy, smoke tests, production gate, packaging, mutation check
infra/          CloudFormation: artifacts, Cognito app clients, Web Function
docs/           PLAN.md (plan and readiness), MODEL-EVAL.md (model research)
```

## License

MIT. See [LICENSE](LICENSE).
