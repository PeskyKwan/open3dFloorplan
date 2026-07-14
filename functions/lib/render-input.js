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
