import { timingSafeEqual } from 'node:crypto';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { RenderInputError, renderWithOpenAI } from './lib/openai-render.js';

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const AI_RENDER_ACCESS_TOKEN = defineSecret('AI_RENDER_ACCESS_TOKEN');

const ALLOWED_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://app.openplan3d.com',
  'https://openplan3d--openplan3d.us-east4.hosted.app',
  'http://localhost:5173',
  'http://localhost:8899',
]);

function setCors(req, res) {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function validBearer(header, expected) {
  if (!header?.startsWith('Bearer ') || !expected) return false;
  const actual = Buffer.from(header.slice(7).trim());
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export const aiRender = onRequest({
  region: 'asia-east2',
  timeoutSeconds: 180,
  memory: '1GiB',
  minInstances: 0,
  maxInstances: 1,
  concurrency: 1,
  cors: false,
  secrets: [OPENAI_API_KEY, AI_RENDER_ACCESS_TOKEN],
}, async (req, res) => {
  const originAllowed = setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(originAllowed ? 204 : 403).end();
    return;
  }
  if (!originAllowed) {
    res.status(403).json({ error: 'This app origin is not allowed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST required.' });
    return;
  }
  if (!validBearer(req.get('authorization'), AI_RENDER_ACCESS_TOKEN.value())) {
    res.status(401).json({ error: 'Invalid AI Render access code.' });
    return;
  }

  try {
    const result = await renderWithOpenAI({
      body: req.body,
      apiKey: OPENAI_API_KEY.value(),
    });
    res.set('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof RenderInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    logger.error('AI render failed', {
      message: error instanceof Error ? error.message : String(error),
      status: error?.status,
    });
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 502;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'AI Render failed. Please try again.',
    });
  }
});
