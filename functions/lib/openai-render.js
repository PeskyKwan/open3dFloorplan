import { validateRenderRequest } from './render-input.js';

export { RenderInputError, validateRenderRequest } from './render-input.js';

const MODEL = 'gpt-image-2';
const OUTPUT_SIZE = '1536x1024';

export async function renderWithOpenAI({ body, apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const input = validateRenderRequest(body);

  const form = new FormData();
  const extension = input.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  form.set('model', MODEL);
  form.set('image', new Blob([input.bytes], { type: input.mimeType }), `room-preview.${extension}`);
  form.set('prompt', input.prompt);
  form.set('quality', input.quality);
  form.set('size', OUTPUT_SIZE);
  form.set('output_format', 'jpeg');
  form.set('output_compression', '90');

  const response = await fetchImpl('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Status text below is safer and more useful than leaking an HTML response.
  }

  if (!response.ok) {
    const apiMessage = data?.error?.message;
    const message = typeof apiMessage === 'string'
      ? apiMessage.slice(0, 500)
      : `OpenAI image request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const imageBase64 = data?.data?.[0]?.b64_json;
  if (!imageBase64) throw new Error('OpenAI returned no image.');

  return {
    imageBase64,
    mimeType: 'image/jpeg',
    model: MODEL,
    ...(data?.usage && typeof data.usage === 'object' ? { usage: data.usage } : {}),
  };
}
