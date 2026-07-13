# Secure AI Render setup

The iPhone sends only the current 3D camera preview, render instructions, and a
revocable beta access code to the Firebase Function. The OpenAI API key stays in
Firebase Secret Manager and is never bundled into Capacitor or stored in the
WebView.

## Architecture

`iPhone camera preview → Firebase aiRender → OpenAI Image Edits (gpt-image-2) → JPEG result`

- Draft is the default (`quality=low`) to keep iteration cheap.
- Final render uses `quality=high` only when the user explicitly chooses it.
- The beta access code protects the private endpoint. It is intentionally
  separate from the OpenAI credential, so it can be rotated without rotating
  the billing key.
- The Firebase function is capped at one instance and one concurrent render,
  with zero warm instances when idle, to limit private-beta cloud exposure.

## One-time owner setup

1. Create a dedicated OpenAI **project** API key and set project budget alerts.
   Do not paste the key into the app or commit it.
2. Authenticate Firebase CLI:

   ```bash
   npx firebase-tools login
   ```

3. Store the OpenAI key when the CLI prompts securely:

   ```bash
   npx firebase-tools functions:secrets:set OPENAI_API_KEY
   ```

4. Generate a random beta access code, keep a copy for the iPhone, then store it
   as the second secret:

   ```bash
   openssl rand -base64 32
   npx firebase-tools functions:secrets:set AI_RENDER_ACCESS_TOKEN
   ```

5. Install and deploy the function:

   ```bash
   npm --prefix functions install
   npx firebase-tools deploy --only functions:aiRender
   ```

6. On iPhone: 3D → place Interior Camera → **AI Render** → paste the beta access
   code → **Save**. Never paste the OpenAI key there.

## Local or alternate backend

The mobile build defaults to:

`https://asia-east2-openplan3d-55cb6.cloudfunctions.net/aiRender`

Override it at build time when needed:

```bash
VITE_AI_RENDER_API_URL=https://example.com/ai-render npm run build:mobile
```

## Before a public App Store release

The access-code gate is suitable for Sum's private beta/TestFlight. Before a
public release, replace it with real user authentication plus Firebase App
Check/App Attest and server-side per-user quotas. Keep OpenAI project spending
limits and alerts enabled.
