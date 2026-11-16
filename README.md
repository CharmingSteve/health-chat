# health-chat

A private assistant for your own health data. It runs as an AWS Lambda Web Function (Node.js 24),
behind the same Cognito login as stuntman-diet.

**What works today:** sign-in, a protected model check, the guide page, the deploy pipeline, and smoke tests.
**Not built yet:** ingesting your data, SQL queries over it, and the charts. See [docs/PLAN.md](docs/PLAN.md).

## Requirements

- Node.js 24 (`engines` is `>=24 <25`)
- AWS CLI v2
- The `click` AWS profile, for account 570989156105 in us-east-1

```bash
export AWS_PROFILE=click AWS_REGION=us-east-1
```

## Commands

```bash
npm ci                       # install dependencies
npm test                     # unit tests (Vitest) and deploy-logic tests (node:test)
npm run mutation             # plants known bugs and fails if the tests miss any
npm run build                # compile to dist/
npm run package              # build dist/health-chat.zip for Lambda
npm run dev                  # local server on http://localhost:3000 (needs the env vars in .env.example)
```

Deploying is done by CI, not by hand. See below.

## How deployment works

1. Push to `main`. CI runs the tests, the mutation check, the CloudFormation lint, and packaging.
2. CI deploys **staging** (`scripts/deploy.mjs staging`), then runs the Cognito smoke tests.
3. **Production** waits for approval in the GitHub `production` environment. After you approve, CI deploys
   production and runs the same smoke tests.

Smoke tests (`scripts/cloud-smoke.mjs`) check:

- `GET /health` returns 200.
- Protected routes return 401 with no token.
- A Cognito machine token with only the `health-smoke/query` scope can run the model check, and is refused (403) on other routes.

## Model

The model is set in one place: the `BedrockModel` parameter default in `infra/template.yaml`
(currently `us.amazon.nova-2-lite-v1:0`). Deploy reads that default, so staging and production always match.

## Sign-in

Uses the existing stuntman-diet Cognito user pool, so the same account signs in. This app adds its own
browser client, with its own callback URL. Sign-in uses the authorization code flow with PKCE.

## Data and privacy

- Health data is not stored in this repo. `.gitignore` blocks data file types, and `data/` is ignored.
- Encryption uses AWS-managed keys only.
- Logs record counts and error types, not health content.
- The app is not medical advice. Contact a doctor about urgent symptoms or values.

## Layout

```
src/            server (Hono), auth (Cognito JWT), Bedrock call
public/         browser page with sign-in, model check, and guide dropdowns
tests/          Vitest tests (auth, routes, smoke rules) and node:test deploy tests
scripts/        deploy, smoke tests, production gate, packaging, mutation check
infra/          CloudFormation: artifacts, Cognito app clients, Web Function
docs/           PLAN.md (plan and readiness), MODEL-EVAL.md (model research)
```
