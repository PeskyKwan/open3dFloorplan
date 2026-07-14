import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWithVertex, VERTEX_LOCATION, VERTEX_MODEL } from '../lib/vertex-render.js';

const imageBytes = Buffer.from('camera-preview');
const imageDataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`;

test('calls Nano Banana 2 through Vertex with a 16:9 draft image edit', async () => {
  assert.equal(VERTEX_LOCATION, 'global');
  let captured;
  const result = await renderWithVertex({
    body: {
      imageDataUrl,
      prompt: 'Keep the exact room geometry and make the scene photorealistic.',
      quality: 'low',
    },
    projectId: 'test-project',
    generateContent: async (request) => {
      captured = request;
      return {
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'rendered-image', mimeType: 'image/jpeg' } }],
          },
        }],
      };
    },
  });

  assert.equal(captured.model, VERTEX_MODEL);
  assert.equal(captured.contents[0].parts[0].inlineData.data, imageBytes.toString('base64'));
  assert.deepEqual(captured.config.responseModalities, ['IMAGE']);
  assert.equal(captured.config.imageConfig.aspectRatio, '16:9');
  assert.equal(captured.config.imageConfig.imageSize, '1K');
  assert.equal(result.imageBase64, 'rendered-image');
  assert.equal(result.model, VERTEX_MODEL);
});

test('uses 2K for high quality and rejects a response without an image', async () => {
  let captured;
  await assert.rejects(
    renderWithVertex({
      body: {
        imageDataUrl,
        prompt: 'Keep the layout unchanged and add realistic interior materials.',
        quality: 'high',
      },
      projectId: 'test-project',
      generateContent: async (request) => {
        captured = request;
        return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'No image' }] } }] };
      },
    }),
    /returned no image \(STOP\)/,
  );
  assert.equal(captured.config.imageConfig.imageSize, '2K');
});
