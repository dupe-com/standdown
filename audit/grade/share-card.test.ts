import { describe, expect, it } from 'vitest';
import type { GradeResult } from './rubric.ts';
import {
  isShareable,
  renderShareSvg,
  renderSocialSnippet,
  renderTerminalCard,
} from './share-card.ts';

const PASS: GradeResult = {
  score: 100,
  letter: 'A+',
  inert: false,
  standDownRate: 1,
  controlActivateRate: 1,
  hijacks: [],
  total: 20,
  passed: 20,
  note: '',
};

describe('share card', () => {
  it('treats a clean A+ as shareable and a hijack/inert grade as not', () => {
    expect(isShareable(PASS)).toBe(true);
    expect(isShareable({ ...PASS, inert: true })).toBe(false);
    expect(isShareable({ ...PASS, hijacks: [{} as never] })).toBe(false);
    expect(isShareable({ ...PASS, score: 85, letter: 'A-' })).toBe(false);
  });

  it('renders the grade, credit, and repo into every artifact', () => {
    for (const s of [
      renderTerminalCard(PASS),
      renderShareSvg(PASS),
      renderSocialSnippet(PASS),
    ]) {
      expect(s).toContain('A+');
      expect(s).toContain('Dupe.com');
      expect(s).toContain('github.com/dupe-com/standdown');
    }
  });

  it('produces a well-formed, self-contained SVG with no remote refs', () => {
    const svg = renderShareSvg(PASS);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('1200');
    expect(svg).toContain('100<tspan');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no remote assets
  });

  it('keeps every terminal-card row the same visual width', () => {
    const rows = renderTerminalCard(PASS).split('\n');
    const widths = new Set(rows.map((r) => [...r].length));
    expect(widths.size).toBe(1);
  });
});
