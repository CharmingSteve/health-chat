# health-chat

A private assistant for your own health data. It runs as an AWS Lambda Web Function (Node.js 24), behind Cognito sign-in.

## Built in less than a day

This entire app was vibe coded in less than one day by **Steve Bar Yakov Gind**, a DevOps engineer with no real experience with TypeScript, using AI coding assistants.

That is the project's origin story, not a guarantee of correctness or medical reliability. Model answers and visual comparisons can be wrong; check the underlying records and consult a clinician for medical decisions.

## Features

- **Cognito login:** hosted sign-in with authorization code flow and PKCE. The backend verifies Cognito JWT signatures, issuer, expiry, token type, and app client before allowing API access.
- **Natural-language health and diet chat:** ask about trends, relationships, out-of-range lab values, timelines, and gaps across imported records. Amazon Bedrock generates answers using checked, read-only Athena SQL, with the queries shown for inspection.
- **Grounded diet figures:** database-computed totals, averages, and counts; intake versus effective burn; explicit labels for assumed burn; complete, partial, missing, and unknown days distinguished rather than treating missing data as zero.
- **Medical document lookup:** searchable extracted PDF text and normalized lab results with dates, units, reference ranges, and flags. Medication questions are instructed to use the stored documents rather than guess brand ingredients.
- **Persistent conversations:** new chats, reopening previous chats, bounded follow-up context, a recent-chat list, and permanent S3 history containing questions, answers, queries, and result rows. Failed saves are retried on the server and in the browser.
- **Photo uploads:** drag and drop or file selection for JPEG, PNG, and HEIC; browser-side HEIC decoding and analysis-copy generation; capture dates from EXIF with visible fallbacks and manual correction; optional settings and notes; retained original location metadata.
- **On-demand photo browsing:** a collapsed photo library with dated captions and locations where available, and thumbnails fetched only as they approach the viewport.
- **Photo comparisons:** select two to eight uploaded photos, compare them in date order, and save the comparison in the current chat or a new chat. Answers are instructed to describe each image, label visual estimates, and explain limits such as pose and lighting.
- **Photo-aware chat:** attach up to four images to a question, ask the chat to list or view uploaded photos, and continue discussing a comparison using the same analysis images, including after reopening the chat. Older comparisons recover photo links only when their dated headings uniquely identify the images.
- **Data imports:** diet exports and legacy diet CSV; Apple Health records, workouts, GPX routes, and ECG recordings; lab CSV exports, medical PDF text, and an image/DICOM file index. Source files are not changed, and import ledgers record what was read or skipped.
- **Diet refresh:** scheduled weekly import plus a **Refresh diet now** button, with the latest successful import and failed-attempt status.
- **Owner-provided context:** optional stated diet/burn patterns, labelled as statements rather than measurements and excluded from computed totals.
- **In-app guidance and checks:** explanatory guides, a model-response check, a health endpoint, authenticated smoke tests, unit tests, mutation checks, and TypeScript builds.
- **Controlled releases:** CloudFormation infrastructure, CI-built release packages, staging deployment and Cognito smoke tests, then approval-gated production deployment from `main`. Staging cannot read production health data.

**Not built yet:** charts, OCR of scanned medical PDFs or medical-image interpretation in the import pipeline, and cross-source de-duplication of overlapping Apple Health data. Photo chat and progress-photo vision are implemented separately from medical-file ingestion. See [docs/PLAN.md](docs/PLAN.md) for the broader plan.

## Privacy and login at a glance

The app's persistent health records and personally identifiable information (PII), including uploaded photos and saved chats, are kept in **closed, private S3 buckets**, not public buckets or this repository. Buckets block public access, use encryption at rest, and keep versions. Access uses AWS IAM permissions; photo uploads use constrained presigned forms rather than public object access.

**Amazon Cognito handles login** and stores the authentication identities. Private S3 storage does not mean data never leaves S3: the backend queries records through Athena and sends relevant context and analysis images to Amazon Bedrock to answer questions. Original photo files are not sent for photo analysis; smaller re-encoded copies without embedded location metadata are used instead.

The signed-in browser displays private data and stores its access token in session storage. If a chat save fails, the pending turn can remain in browser local storage until it is saved. Photo dates and settings, and locations returned by the photo-list tool, can also form part of model context. See [Privacy](#privacy) and [Where data lives](#where-data-lives).

## Asking questions

1. Sign in, type a question in "Ask about your data", and press Ask.
2. The model writes SQL. The app checks it before running it: one SELECT statement, approved tables only, no comments, at most 500 rows.
3. The answer is shown with the queries it ran. You can rerun any of them in Athena to check the numbers.

What the chat does not do: it does not modify source health records or run write queries. It queries imported tables and can view photo analysis copies, not raw medical files or original photo files. It is not medical advice. Blank days are unknown, not zero. Sodium answers mean blood sodium only.

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
| Original photos, analysis copies, and photo metadata | `health-chat-photos-570989156105-us-east-1-an` | retained; the app does not delete them |
| Chat turns, query results, photo IDs, and activity markers | `health-chat-logs-570989156105-us-east-1-an` | retained; no lifecycle expiration |

Retention rules on the tables bucket: old table versions are deleted after 30 days; Athena results after 7 days.
Every bucket is private, versioned, encrypted with AWS-managed keys, and blocks public access.

### Where imported data goes

Once an import has read the source files from their bucket, the result is not kept in a conventional database. It is written back to S3 as **Parquet** files in the tables bucket, `health-chat-tables-570989156105-us-east-1-an`.

**What Parquet is:** an open file format for tables of data. It stores each column together, compresses well, and keeps the column names and types inside the file. Query engines can therefore read only the columns a question needs, which keeps queries fast and cheap. Parquet files are read by tools, not by people; a text editor shows binary data.

- **Layout**: one folder per table, `<table>/data.parquet`, under `diet/`, `apple/`, and the medical tables. The path comes from `tableLocation()` in `src/ingest/schemas.ts`, which is the single list of tables and columns.
- **Ledgers**: `ledger/apple.json`, `ledger/diet.json`, and `ledger/medical.json` record the source files read and the row counts.
- **Writers**: `src/ingest/diet-pipeline.ts`, `run-apple.ts`, and `run-medical.ts` upload the files. DuckDB runs in memory and is used only to build the Parquet files.
- **Querying**: Glue tables over those folders (`infra/data.yaml`, generated from `schemas.ts`) let Athena run the chat's SQL. Query results go to `athena-results/` in the same bucket.
- **Updates**: each import replaces the tables. Old versions are deleted after 30 days, and Athena results after 7 days.

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

stuntman-diet marks each day `complete`, `partial`, or `missing`; a missing completeness value is `unknown`. Legacy master days are treated as owner-confirmed complete days (`completeness_basis=owner_confirmed_legacy`). In `diet_days`, `net_reliable` marks complete days whose net can be used. Answers are instructed to distinguish incomplete days, state the days included or excluded, and identify all-days versus complete-days figures. Totals and averages are computed by SQL, not by the model.

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

Used for the question box and photo comparisons. Set in one place: the `BedrockModel` parameter default in `infra/template.yaml`
(currently `us.amazon.nova-2-lite-v1:0`). Deploy reads that default, so staging and production always match.

## Privacy

- Health data is not stored in this repo. `.gitignore` blocks data file types.
- Persistent application PII and health content live in private, encrypted, versioned S3 buckets with public access blocked. Cognito stores login identities; it is not the health-record store.
- API access requires a valid Cognito token for the configured app client. The separate smoke-test token can reach only the model-check route.
- Athena processes query data and Bedrock receives the context and analysis images needed for inference. Private storage is not a claim that inference happens locally or that the model never receives personal information.
- Original photos retain location and device metadata by design. Analysis copies are re-encoded without embedded EXIF location, but visible content, captions, and separately supplied metadata can still be identifying.
- The browser holds the login token in session storage and may retain unsaved chat turns in local storage for retry. Use a trusted device.
- Logs record counts and error types, not health content.
- This is not medical advice. Contact a doctor about urgent symptoms or values.

## Layout

```
src/            server (Hono), auth (Cognito JWT), Bedrock call
src/ingest/     import: diet, Apple Health, Parquet writing
public/         browser page: sign-in, chat, photo upload/comparison, model check, guides
tests/          Vitest tests and node:test deploy tests
scripts/        deploy, smoke tests, production gate, packaging, mutation check
infra/          CloudFormation: artifacts, Cognito app clients, Web Function
docs/           PLAN.md (plan and readiness), MODEL-EVAL.md (model research)
```

## License

MIT. See [LICENSE](LICENSE).
