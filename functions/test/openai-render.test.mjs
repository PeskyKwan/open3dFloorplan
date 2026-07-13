import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderInputError, renderWithOpenAI, validateRenderRequest } from '../lib/openai-render.js';

const onePixelPng = `data:image/png;base64,${Buffer.from('not-a-real-png-but-valid-bytes').toString('base64')}`;

test('validates and defaults draft renders to low quality', () => {
  const result = validateRenderRequest({
    imageDataUrl: onePixelPng,
    prompt: 'Keep the room geometry and add realistic materials.',
    quality: 'unexpected',
  });
  assert.equal(result.quality, 'low');
  assert.equal(result.mimeType, 'image/png');
});

test('rejects malformed camera previews', () => {
  assert.throws(
    () => validateRenderRequest({ imageDataUrl: 'nope', prompt: 'A sufficiently long render prompt.' }),
    RenderInputError,
  );
});

test('calls GPT Image 2 edit endpoint without exposing the API key in output', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: 'rendered-image' }] }),
    };
  };

  const result = await renderWithOpenAI({
    body: {
      imageDataUrl: onePixelPng,
      prompt: 'Keep the exact layout and make this room photorealistic.',
      quality: 'high',
    },
    apiKey: 'server-secret',
    fetchImpl,
  });

  assert.equal(captured.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(captured.options.headers.Authorization, 'Bearer server-secret');
  assert.equal(captured.options.body.get('model'), 'gpt-image-2');
  assert.equal(captured.options.body.get('quality'), 'high');
  assert.equal(result.imageBase64, 'rendered-image');
  assert.equal(JSON.stringify(result).includes('server-secret'), false);
});
