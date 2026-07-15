const DEFAULT_AI_RENDER_ENDPOINT =
  'https://asia-east2-openplan3d-55cb6.cloudfunctions.net/aiRender';
const DEFAULT_OPENAI_RENDER_ENDPOINT =
  'https://us-central1-openplan3d-55cb6.cloudfunctions.net/aiRenderOpenAIComparison';

export const AI_RENDER_ACCESS_TOKEN_KEY = 'o3d_ai_render_access_token';

export type AIRenderQuality = 'low' | 'high';
export type AIRenderProvider = 'nano-banana-2' | 'gpt-image-2';

export interface AIRenderRequest {
  imageDataUrl: string;
  prompt: string;
  quality: AIRenderQuality;
  provider: AIRenderProvider;
  accessToken: string;
  signal?: AbortSignal;
}

interface AIRenderResponse {
  imageBase64?: string;
  mimeType?: string;
  model?: string;
  error?: string;
}

export interface AIRenderResult {
  dataUrl: string;
  model: string;
  provider: AIRenderProvider;
}

export function getAIRenderEndpoint(provider: AIRenderProvider = 'nano-banana-2'): string {
  if (provider === 'gpt-image-2') {
    const configured = import.meta.env.VITE_OPENAI_RENDER_API_URL?.trim();
    return configured || DEFAULT_OPENAI_RENDER_ENDPOINT;
  }
  const configured = import.meta.env.VITE_AI_RENDER_API_URL?.trim();
  return configured || DEFAULT_AI_RENDER_ENDPOINT;
}

export function getAIRenderAccessToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(AI_RENDER_ACCESS_TOKEN_KEY) ?? '';
}

export function saveAIRenderAccessToken(token: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = token.trim();
  if (trimmed) localStorage.setItem(AI_RENDER_ACCESS_TOKEN_KEY, trimmed);
  else localStorage.removeItem(AI_RENDER_ACCESS_TOKEN_KEY);
}

export async function requestAIRender(input: AIRenderRequest): Promise<AIRenderResult> {
  const response = await fetch(getAIRenderEndpoint(input.provider), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${input.accessToken.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imageDataUrl: input.imageDataUrl,
      prompt: input.prompt,
      quality: input.quality,
    }),
    signal: input.signal,
  });

  let data: AIRenderResponse = {};
  try {
    data = await response.json() as AIRenderResponse;
  } catch {
    // Keep the friendlier status-based error below when the proxy returns no JSON.
  }

  if (!response.ok) {
    throw new Error(data.error || `AI Render server error (${response.status})`);
  }
  if (!data.imageBase64) {
    throw new Error('AI Render server returned no image. Please try again.');
  }

  return {
    dataUrl: `data:${data.mimeType || 'image/jpeg'};base64,${data.imageBase64}`,
    model: data.model || input.provider,
    provider: input.provider,
  };
}
