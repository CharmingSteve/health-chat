# Model research for health-chat (as of 2026-11-16)

Account 570989156105, region us-east-1, profile `click`.

## 1. Claude is not available to this account

`anthropic.claude-haiku-5-5` returned:

    AccessDeniedException: anthropic.claude-haiku-5-5 is not available for this account.

Both `anthropic.claude-haiku-5-5` and `us.anthropic.claude-haiku-5-5` failed the same way.
Claude is off the table until access is granted in the Bedrock console (model access).
The Bedrock list shows Claude models, but listing is not the same as having access.

## 2. Official on-demand prices (AWS Price List API, us-east-1, USD per 1M tokens)

| Model ID | Input | Output | Image input | Document (PDF) input |
|---|---|---|---|---|
| `amazon.nova-micro-v1:0` | 0.035 | 0.14 | no (TEXT only) | no |
| `amazon.nova-lite-v1:0` | 0.06 | 0.24 | yes | not listed as a modality |
| `amazon.nova-2-lite-v1:0` (in-region) | 0.33 | 2.75 | yes | not listed as a modality |
| `us.amazon.nova-2-lite-v1:0` (cross-region, the stuntman default) | 0.30 | 2.50 | yes | not listed as a modality |
| `anthropic.claude-haiku-5-5` | not found in the price list | | | |

Sources: `aws pricing get-products --service-code AmazonBedrock`, filtered for these models.
Nova Micro is cheapest but cannot read images or PDFs, so it only fits text-only steps.

## 3. Document input

- The Converse `document` block accepts only `pdf` or `txt`, and only as inline `bytes` or `content`.
  `s3Location` is not allowed for documents.
  Source: https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
- The model metadata for the Nova models lists `TEXT`, `IMAGE`, and `VIDEO` input, not `DOCUMENT`.
  So PDF support is not confirmed per model. Treat PDF input as untested.
- Plan: render each PDF page to PNG locally (macOS `qlmanage`, or a rasterizer in the prep job),
  then send images. Bedrock accepts PNG image input for the Nova Lite models.

## 4. Hebrew test results (one page, non-medical)

Test page: Shabbat schedule PDF (public calendar, not personal data), rendered to PNG,
prompt: transcribe the Hebrew heading.

- `amazon.nova-lite-v1:0`: the Hebrew text came back mostly readable, with a plausible heading and a
  candle-lighting time. Some words are off.
- `us.amazon.nova-2-lite-v1:0`: the Hebrew came back garbled, with words that do not appear on the page.

Hebrew text-only test: Nova Lite and Nova 2 Lite both translated a short Hebrew lab line correctly
(a lab value line). This is not evidence for OCR quality on scanned lab forms.

## 5. Decision for now

- Start the bake-off with `amazon.nova-lite-v1:0` (cheapest vision model) and
  `us.amazon.nova-2-lite-v1:0` (current stuntman default).
- Build a small gold set from the hospital PDFs (sodium, CRP, blood-count and similar values).
  Score each model on exact numeric matches. Pick the cheapest model that scores 100% on the
  numeric fields, then review anything with a unit or reference range mismatch by hand.
- Extraction runs once, in the prep job, and writes values to `lab_results`. Chat answers query
  stored tables, so each question does not re-read the PDFs. This keeps the Bedrock bill low.

## Sources

- Lambda Web Functions: https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
- Web Function runtimes (Node.js 24 only): https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html
- Endpoint access control: https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html
- Bedrock Converse API: https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
