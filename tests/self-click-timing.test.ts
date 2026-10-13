import { describe, expect, it } from 'vitest';
import { collectContentSignals } from '../src/content';
import { cjPolicy } from '../src/policies';
import { captureLanding } from '../src/relay/capture';

// A fresh own click is the page's first, normal navigation. A reload or
// back/forward re-shows the same URL (own param and all) and is not a new click.
const nav = (type: string) => ({
  timeOrigin: 1_234.6,
  getEntriesByType: (kind: string) => (kind === 'navigation' ? [{ type }] : []),
});
const contentWindow = (type?: string) => ({
  location: { href: 'https://shop.example/?cjevent=own' },
  document: { referrer: '', cookie: '' },
  ...(type ? { performance: nav(type) } : {}),
});

describe('own-click timing: only a fresh navigation counts as a click', () => {
  it('content: a normal navigation reports when the page started loading', () => {
    expect(collectContentSignals({ window: contentWindow('navigate'), now: () => 5_000 }).selfClickAt).toBe(1_235);
  });

  for (const type of ['reload', 'back_forward', 'prerender']) {
    it(`content: a ${type} reports no click time`, () => {
      expect(collectContentSignals({ window: contentWindow(type), now: () => 5_000 })).not.toHaveProperty('selfClickAt');
    });
  }

  it('content: no Navigation Timing → no click time (fails toward not lifting)', () => {
    expect(collectContentSignals({ window: contentWindow(), now: () => 5_000 })).not.toHaveProperty('selfClickAt');
  });

  const capture = (type?: string) =>
    captureLanding({
      policies: [cjPolicy],
      selfPatterns: [{ name: 'cjevent', value: 'own', match: 'equals', networkId: 'cj' }],
      selfClickLift: 'same-network',
      now: () => 5_000,
      sendMessage: () => true,
      window: {
        location: { href: 'https://shop.example/?cjevent=own' },
        document: { referrer: '' },
        ...(type ? { performance: nav(type) } : {}),
      },
    })?.record;

  it('relay capture: a normal navigation reports the own click', () => {
    expect(capture('navigate')).toMatchObject({ self: ['cj'] });
  });

  for (const type of ['reload', 'back_forward']) {
    it(`relay capture: a ${type} does not report an own click`, () => {
      expect(capture(type)).not.toHaveProperty('self');
    });
  }
});
