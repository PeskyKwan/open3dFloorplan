import { writable } from 'svelte/store';

export type ViewportKind = 'phone' | 'tablet' | 'desktop';

/** Breakpoints (CSS px). phone < 640, tablet 640–1024, desktop > 1024. */
export function kindForWidth(w: number): ViewportKind {
  if (w < 640) return 'phone';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

/** Current viewport kind — drives whether the phone/tablet or desktop layout renders. */
export const viewportKind = writable<ViewportKind>(
  typeof window === 'undefined' ? 'desktop' : kindForWidth(window.innerWidth)
);

/** Call once (e.g. in the editor page onMount). Returns an unsubscribe/cleanup fn. */
export function initViewportTracking(): () => void {
  if (typeof window === 'undefined') return () => {};
  const update = () => viewportKind.set(kindForWidth(window.innerWidth));
  update();
  window.addEventListener('resize', update);
  return () => window.removeEventListener('resize', update);
}
