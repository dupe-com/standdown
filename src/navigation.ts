/**
 * Navigation Timing helpers shared by the content adapter and the relay capture.
 * Dependency-free so the `document_start` capture bundle stays small.
 */

/** The slice of `window.performance` used to tell a fresh navigation from a re-show. */
export interface NavigationTimingLike {
  readonly timeOrigin?: number;
  getEntriesByType?(type: 'navigation'): readonly { readonly type?: string }[];
}

/**
 * When this document's navigation started, if it was a fresh one. A reload,
 * back/forward or prerender re-shows a URL (own-click param and all) without a
 * new click, so it yields `undefined`, as does a missing Navigation Timing API.
 */
export function freshNavigationStart(performance: NavigationTimingLike | undefined): number | undefined {
  try {
    const entry = performance?.getEntriesByType?.('navigation')[0];
    const origin = performance?.timeOrigin;

    return entry?.type === 'navigate' && typeof origin === 'number' && Number.isFinite(origin)
      ? Math.round(origin)
      : undefined;
  } catch {
    return undefined;
  }
}
