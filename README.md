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

## Progress photos

- Drag photos into the photo section from Photos or Finder (Chrome or Safari on a Mac), or click the area to choose files. JPG, PNG, and HEIC are accepted, up to 20 files at a time, 10 MB each.
- The date comes from the photo itself (the camera's capture date). If a photo has none, the file's date is used, and failing that, today. Each row shows where its date came from, and you can change it before uploading. A future date or one before 2000 is flagged, not blocked.
- HEIC photos are decoded in the browser to make the analysis copy. If a HEIC can't be read in the browser, export a JPEG from Photos instead; nothing is uploaded for that file.
- Each photo is stored in `health-chat-photos-570989156105-us-east-1-an`: the original as you took it (location and device details kept), and a smaller analysis copy made in the browser (re-encoded, so it carries no location). Nothing is deleted.
- Select two to eight uploaded photos and press **Compare selected photos**. The app compares their analysis copies in date order, describes each photo before comparing, and saves the answer in the current chat (or starts a new one). It should state when lighting, pose, or unclear images prevent a reliable comparison.
- Continue in that chat to ask about the comparison. The same analysis images are loaded for follow-up questions, including after reopening the chat; only photo IDs, not image bytes, are saved in chat history. Older comparisons recover their photo links only when the dated headings uniquely identify the uploaded photos.
- Estimates are not measurements. Measured weights and body-composition readings are the reference.

Manual checks (automated tests can't drag files):

- Drag a HEIC from Photos into Chrome on the Mac. The date should match the photo.
- Drag a HEIC from Finder into Chrome.
- Drag a JPEG from Photos into Chrome.
- Add a photo from Safari on the iPhone.
- Drop several files at once. Each row shows its own date.

## Owner's stated pattern

An optional file, `notes/owner_patterns.json` in the tables bucket, holds your stated typical intake and burn (for example for Fridays). It is added to each question as your statement, not measured data, and it never enters totals or averages. The app can read it but not write it. Upload a new version to change it.

## Burn and net calories

A day's burn is the recorded burn if one was written; otherwise the default of 2,000 kcal is assumed. stuntman-diet writes a burn only when it is above 2,000 (exercise), so a day without one is a default day. In `diet_days`, `burn_effective` is the burn used for net calories and `burn_basis` says whether it was `recorded` or `assumed_default`. Days with no food or burn entries are not tracked, and no burn is assumed for them. The chat labels assumed burns each time it uses them.

## Completeness of days

stuntman-diet marks each day `complete`, `partial`, or `missing`. Older legacy days have no mark, so they are `unknown`. In `diet_days`, `net_reliable` is true only for complete days. The chat leaves partial, missing, and unknown days out of totals and averages unless you ask for them, and says how many it left out. Totals and averages are computed by SQL, not by the model.

## Adding new data

Run these from the repo root, with `export AWS_PROFILE=click AWS_REGION=us-east-1`. Each import reads the sources again and replaces the tables, so re-running is safe. Afterwards, check the ledger (below) and ask a test question.

### Apple Health (new export)

1. On the iPhone: Health, profile picture, Export All Health Data. Copy the export to your Mac.
2. Rename the exported folder to `Month-DD-YYYY` (for example `November-30-2026`) and upload it to the apple-health bucket. It must keep the layout `export.xml`, `workout-routes/`, `electrocardiograms/`. Example:
   `aws s3 cp November-30-2026/ s3://apple-health-570989156105-us-east-1-an/November-30-2026/ --recursive`
3. Run `npm run ingest:apple`. It picks the newest dated folder, so the older exports are not read again.
4. Check `ledger/apple.json` in the tables bucket: the `export_folder` should be the new one, and `duplicates_removed` shows how many identical records were dropped.

### Diet (daily entries from stuntman-diet)

Diet imports itself every Sunday at 06:00 (Asia/Jerusalem). A weekly Lambda copies the newest stuntman-diet snapshot into the diet bucket, keeps it there (stuntman's own copies expire), and rebuilds the diet tables. Nothing needs to be done by hand.

- **Refresh now:** the "Refresh diet now" button on the page runs the same import at once. The status line shows the last successful import (time, days covered, the snapshot used) and any failed attempt. A failed attempt does not change the last good data.
- **Schedule and job:** `infra/diet-job.yaml` (production only). The job has one run at a time, and failed runs go to a dead-letter queue.
- **Manual run:** `npm run ingest:diet` runs the same import from your machine (uses the `click` profile).
- Named exclusions are in `src/ingest/diet.ts` (`DIET_EXCLUSIONS`). Each exclusion is counted in `ledger/diet.json`.

The legacy master CSV is read from `legacy-master/` in the diet bucket. It is not updated from now on; new days come from stuntman-diet.

### Medical (lab exports and PDFs)

- **Clalit lab exports:** upload each new `PersonList (n).csv` into `blood-tests/<year>/` in the medical bucket. The import reads only files with that name pattern in that folder.
- **Other PDFs** (hospital letters, referrals, results): upload to one of the allowlisted folders: `blood-tests/`, `broken-shoulder/`, `cardiology/`, `foot-x-ray/`, `hernia/`, `tests/`, or the physiotherapy folder. Files at the top level of the bucket are also read.
- **Images and DICOM files:** upload to an allowlisted folder. They are indexed by name, size, and date only.
- Run `npm run ingest:medical`.
- A new folder is not read until it is added to `ALLOWED_FOLDERS` in `src/ingest/medical-classify.ts`. That is a code change, so make it through a PR.
- Lab names not in `NAME_MAP` (`src/ingest/labs.ts`) are kept under their raw names and listed in `ledger/medical.json` under `unknown_lab_names`. Add a mapping, and add a test for it.

### Check the result

- Ledgers in `s3://health-chat-tables-570989156105-us-east-1-an/ledger/` (`apple.json`, `diet.json`, `medical.json`) list the source files read, the row counts, and what was skipped and why.
- In the browser, ask a question such as "how many diet entries are there for each source?" The answer shows the SQL, so you can see what was read.

### Things to avoid

- Do not upload anything into the tables bucket by hand. Tables are written only by the import scripts.
- Do not change a source file after upload to fix a value. Fix it in the source (re-export or re-scan), then re-run the import.
- If an import stops with an error, some tables may already have been rebuilt and others not. Fix the cause in the source, then re-run the same import; it rebuilds every table from the sources.

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
npm run dev                    # local server on http://localhost:3000 (copies the browser libraries first)
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
