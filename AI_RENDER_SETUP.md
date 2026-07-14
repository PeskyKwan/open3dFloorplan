# Secure AI Render setup

The iPhone sends only the current 3D camera preview, render instructions, and a
revocable beta access code to the Firebase Function. Google Cloud IAM stays on
the server; no model API key is bundled into Capacitor or stored in the WebView.

## Architecture

`iPhone camera preview → Firebase aiRender (Hong Kong) → Vertex Nano Banana 2 → JPEG result`

- Model: `gemini-3.1-flash-image` (Nano Banana 2), official Vertex `global`
  model endpoint.
- Function and Firestore quota database: `asia-east2` (Hong Kong).
- Quick draft: 1K, one credit. High quality: 2K, two credits.
- Hard server quota: 10 credits per Hong Kong calendar day and 60 credits per
  Hong Kong calendar month. Attempts reserve credits before the model call so
  retries or provider failures cannot bypass the spend guard.
- The beta access code protects the private endpoint and can be rotated without
  changing Google Cloud IAM.
- The function is capped at one instance and one concurrent render, with zero
  warm instances when idle.

## One-time owner setup

Current Firebase project: `openplan3d-55cb6`.

1. Enable `aiplatform.googleapis.com` and `firestore.googleapis.com`.
2. Create Firestore `(default)` in `asia-east2`, Standard edition. Keep client
   rules closed; quota writes use the Firebase Admin SDK.
3. Give the Cloud Function runtime service account only the Vertex prediction
   permission it needs. The current project runtime account already has access.
4. Generate a random beta access code, keep a copy for the iPhone, then store it
   securely:

   ```bash
   openssl rand -base64 32
   npx firebase-tools functions:secrets:set AI_RENDER_ACCESS_TOKEN
   ```

5. Install and deploy:

   ```bash
   npm --prefix functions install
   npx firebase-tools deploy --only functions:aiRender
   ```

6. On iPhone: 3D → place Interior Camera → **AI Render** → paste the beta access
   code → **Save**. Never paste a Google API key there.

## Local or candidate backend

The mobile build defaults to:

`https://asia-east2-openplan3d-55cb6.cloudfunctions.net/aiRender`

Override it at build time when testing the independent candidate:

```bash
VITE_AI_RENDER_API_URL=https://asia-east2-openplan3d-55cb6.cloudfunctions.net/aiRenderCandidate npm run build:mobile
```

## Optional GPT Image 2 comparison

`aiRenderOpenAIComparison` is an isolated, access-code protected A/B endpoint.
It runs in `us-central1` because OpenAI rejects Cloud Functions egress from Hong
Kong; the normal app endpoint remains Nano Banana 2 in `asia-east2`.

It requires the existing `OPENAI_API_KEY` secret and shares the same Firestore
daily/monthly credit reservation as production. Deploy it independently:

```bash
npx firebase-tools deploy --only functions:aiRenderOpenAIComparison --project openplan3d-55cb6
```

Do not point a production build at this endpoint without first deciding whether
quick drafts, high-quality renders, or both should use OpenAI.

## Before a public App Store release

The access-code gate is suitable for Sum's private beta/TestFlight. Before a
public release, replace it with real user authentication plus Firebase App
Check/App Attest and per-user quotas. Keep Google Cloud billing alerts enabled;
budgets are alerts, while the Firestore credit counter is the hard app guard.
