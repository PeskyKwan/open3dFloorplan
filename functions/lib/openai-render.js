const MODEL = 'gpt-image-2';
const OUTPUT_SIZE = '1536x1024';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1800;

function parseInputImage(imageDataUrl) {
  if (typeof imageDataUrl !== 'string') {
    throw new RenderInputError('A PNG camera preview is required.');
  }

  const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new RenderInputError('Camera preview must be a PNG or JPEG data URL.');
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new RenderInputError('Camera preview must be smaller than 5 MB.');
  }

  return { bytes, mimeType: match[1] };
}

export class RenderInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderInputError';
  }
}

export function validateRenderRequest(body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 20 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new RenderInputError(`Prompt must be between 20 and ${MAX_PROMPT_LENGTH} characters.`);
  }

  const quality = body?.quality === 'high' ? 'high' : 'low';
  const image = parseInputImage(body?.imageDataUrl);
  return { prompt, quality, ...image };
}

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
  };
}
