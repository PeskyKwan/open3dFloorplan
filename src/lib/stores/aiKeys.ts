/** Gemini desktop-experiment key management.
 * Provider credentials must never live here; mobile renders use server-side
 * Vertex IAM through the proxy in $lib/services/aiRender.
 */

const GEMINI_KEY = 'o3d_gemini_key';

export function getGeminiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(GEMINI_KEY);
}

export function hasGeminiKey(): boolean {
  return !!getGeminiKey();
}
