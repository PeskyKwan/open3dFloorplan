import { writable } from 'svelte/store';

export type ViewportKind = 'phone' | 'tablet' | 'desktop';

/** True when running inside the native Capacitor app (iPhone/iPad shell). */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const c = (window as any).Capacitor;
  return !!(c && c.isNativePlatform && c.isNativePlatform());
}

/** Breakpoints (CSS px). phone < 640, tablet 640–1024, desktop > 1024. */
export function kindForWidth(w: number): ViewportKind {
  if (w < 640) return 'phone';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

/**
 * Inside the native app we ALWAYS use the phone layout — it's an iPhone-first
 * app and the desktop layout is unusable on a handset in any orientation.
 */
function currentKind(): ViewportKind {
  if (isNativeApp()) return 'phone';
  return kindForWidth(window.innerWidth);
}

/** Current viewport kind — drives whether the phone/tablet or desktop layout renders. */
export const viewportKind = writable<ViewportKind>(
  typeof window === 'undefined' ? 'desktop' : currentKind()
);

/** Call once (e.g. in the editor page onMount). Returns an unsubscribe/cleanup fn. */
export function initViewportTracking(): () => void {
  if (typeof window === 'undefined') return () => {};
  const update = () => viewportKind.set(currentKind());
  update();
  window.addEventListener('resize', update);
  return () => window.removeEventListener('resize', update);
}
