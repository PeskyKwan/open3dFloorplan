import { GoogleGenAI, Modality } from '@google/genai';
import { validateRenderRequest } from './render-input.js';

export const VERTEX_MODEL = 'gemini-3.1-flash-image';
// Nano Banana 2 is published on Vertex's official global model endpoint.
// The function and quota database remain in asia-east2 (Hong Kong).
export const VERTEX_LOCATION = 'global';

const clients = new Map();

function getClient(projectId, location) {
  const key = `${projectId}:${location}`;
  if (!clients.has(key)) {
    clients.set(key, new GoogleGenAI({
      enterprise: true,
      project: projectId,
      location,
      apiVersion: 'v1',
      httpOptions: {
        timeout: 170_000,
        retryOptions: { attempts: 1 },
      },
    }));
  }
  return clients.get(key);
}

function findGeneratedImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  return parts.find((part) => typeof part?.inlineData?.data === 'string')?.inlineData;
}

export async function renderWithVertex({
  body,
  projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT,
  location = process.env.VERTEX_LOCATION || VERTEX_LOCATION,
  generateContent,
}) {
  if (!projectId) throw new Error('Google Cloud project ID is not configured.');
  const input = validateRenderRequest(body);
  const request = {
    model: VERTEX_MODEL,
    contents: [{
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: input.mimeType,
            data: input.bytes.toString('base64'),
          },
        },
        { text: input.prompt },
      ],
    }],
    config: {
      responseModalities: [Modality.IMAGE],
      imageConfig: {
        aspectRatio: '16:9',
        imageSize: input.quality === 'high' ? '2K' : '1K',
        outputMimeType: 'image/jpeg',
        outputCompressionQuality: 90,
      },
    },
  };

  const call = generateContent
    ?? ((params) => getClient(projectId, location).models.generateContent(params));
  const response = await call(request);
  const generated = findGeneratedImage(response);
  if (!generated?.data) {
    const blockReason = response?.promptFeedback?.blockReason;
    const finishReason = response?.candidates?.[0]?.finishReason;
    const detail = blockReason || finishReason;
    throw new Error(detail
      ? `Nano Banana 2 returned no image (${detail}).`
      : 'Nano Banana 2 returned no image.');
  }

  return {
    imageBase64: generated.data,
    mimeType: generated.mimeType || 'image/jpeg',
    model: VERTEX_MODEL,
  };
}
