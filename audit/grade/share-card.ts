/**
 * Shareable grade card. Turns a {@link GradeResult} into three artifacts an
 * integrator can show off after a passing conformance run:
 *
 *   1. a terminal card (ASCII box) printed at the end of the grade,
 *   2. a self-contained SVG (1200×630, OpenGraph ratio) written to disk — the
 *      thing you actually post to X / LinkedIn, and
 *   3. a copy-paste social snippet.
 *
 * All three credit the project and its maintainer ("a project by Dupe.com") so
 * the brag carries a little love back upstream. Zero dependencies — the SVG is a
 * templated string, the file write is `node:fs`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GradeResult } from './rubric.ts';

const REPO_URL = 'github.com/dupe-com/standdown';
const CREDIT = 'a project by Dupe.com';

/** Passing = safe to brag: not inert, zero hijacks, A-band or better. */
export function isShareable(result: GradeResult): boolean {
  return !result.inert && result.hijacks.length === 0 && result.score >= 90;
}

/** Grade → accent color by band (green pass / amber mid / red fail). */
function accentFor(score: number): string {
  if (score >= 90) return '#3FB950';
  if (score >= 70) return '#F5A623';
  return '#E5484D';
}

function bullets(result: GradeResult): string[] {
  const standDownPct = Math.round(result.standDownRate * 100);
  return [
    result.hijacks.length === 0
      ? 'Respected every existing attribution — 0 hijacks'
      : `${result.hijacks.length} hijack(s) — attribution overridden`,
    `${standDownPct}% stand-down on attributed scenarios`,
    'Decisions made locally, on-device — never on a server',
  ];
}

// ── Terminal card ───────────────────────────────────────────────────────────

const INNER = 60; // chars between the borders

function line(content = ''): string {
  const trimmed = content.length > INNER ? content.slice(0, INNER) : content;
  return `  │ ${trimmed.padEnd(INNER)} │`;
}

/** ASCII box for stdout. Single-width glyphs only, so it stays aligned. */
export function renderTerminalCard(result: GradeResult): string {
  const top = `  ┌${'─'.repeat(INNER + 2)}┐`;
  const bottom = `  └${'─'.repeat(INNER + 2)}┘`;
  const rows = [
    top,
    line(),
    line('  standdown conformance'),
    line(),
    line(`     ${result.letter}   ·   ${result.score}/100`),
    line(),
    ...bullets(result).map((b) => line(`  ✓ ${b}`)),
    line(),
    line(`  ${CREDIT}`),
    line(`  ${REPO_URL}`),
    line(),
    bottom,
  ];
  return rows.join('\n');
}

// ── Social snippet ──────────────────────────────────────────────────────────

export function renderSocialSnippet(result: GradeResult): string {
  return (
    `My extension scored ${result.letter} (${result.score}/100) on the standdown ` +
    `affiliate conformance grader — ${result.hijacks.length === 0 ? '0 hijacks' : `${result.hijacks.length} hijacks`}, ` +
    `decisions made 100% client-side. 🛡️ standdown — ${CREDIT} → ${REPO_URL}`
  );
}

// ── SVG card ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface ShareSvgOptions {
  /** Override the big grade letter in the ring (default: result.letter). */
  letter?: string;
  /** Override the subtitle under the score (default: "affiliate stand-down, graded"). */
  caption?: string;
  /** Override the accent color (default: derived from the score band). */
  accent?: string;
  /** Override the top-strip eyebrow (default: "STANDDOWN CONFORMANCE"). */
  eyebrow?: string;
}

/** Self-contained 1200×630 SVG — no external fonts, no remote assets. */
export function renderShareSvg(result: GradeResult, opts: ShareSvgOptions = {}): string {
  const accent = opts.accent ?? accentFor(result.score);
  const letter = opts.letter ?? result.letter;
  const caption = opts.caption ?? 'affiliate stand-down, graded';
  const eyebrow = opts.eyebrow ?? 'STANDDOWN CONFORMANCE';
  const font =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const rows = bullets(result)
    .map(
      (b, i) =>
        `<text x="90" y="${430 + i * 52}" font-family="${font}" font-size="26" fill="#C9C4BC">` +
        `<tspan fill="${accent}" font-weight="700">✓</tspan>  ${esc(b)}</text>`,
    )
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="standdown grade ${esc(letter)}">
  <rect width="1200" height="630" fill="#1C1917"/>
  <rect x="0" y="0" width="1200" height="10" fill="${accent}"/>
  <text x="90" y="130" font-family="${font}" font-size="30" fill="#8A8175" letter-spacing="3">${esc(eyebrow)}</text>
  <circle cx="945" cy="235" r="150" fill="none" stroke="${accent}" stroke-width="14"/>
  <text x="945" y="235" font-family="${font}" font-size="150" font-weight="800" fill="${accent}" text-anchor="middle" dominant-baseline="central">${esc(letter)}</text>
  <text x="90" y="250" font-family="${font}" font-size="150" font-weight="800" fill="#F7F5F2">${result.score}<tspan font-size="70" fill="#8A8175">/100</tspan></text>
  <text x="90" y="315" font-family="${font}" font-size="28" fill="#8A8175">${esc(caption)}</text>
  ${rows}
  <line x1="90" y1="560" x2="1110" y2="560" stroke="#3A342E" stroke-width="1"/>
  <text x="90" y="600" font-family="${font}" font-size="24" fill="#8A8175">${CREDIT}</text>
  <text x="1110" y="600" font-family="${font}" font-size="24" fill="#8A8175" text-anchor="end">${REPO_URL}</text>
</svg>
`;
}

// ── Emit (called by the grader CLIs) ─────────────────────────────────────────

export interface EmitOptions {
  /** Directory to write the SVG into. Defaults to the current working dir. */
  outDir?: string;
  /** Basename for the SVG (no extension). Defaults to `standdown-grade`. */
  fileName?: string;
}

/**
 * Print the shareable card to stdout and, on a passing grade, write the SVG and
 * print the social snippet. No-op on a non-shareable grade beyond the terminal
 * card — nobody wants to be told to post a C.
 */
export function emitShareCard(result: GradeResult, opts: EmitOptions = {}): void {
  if (!isShareable(result)) return;

  console.log('\n' + renderTerminalCard(result));

  const outDir = opts.outDir ?? process.cwd();
  const fileName = `${opts.fileName ?? 'standdown-grade'}.svg`;
  const outPath = resolve(outDir, fileName);
  try {
    writeFileSync(outPath, renderShareSvg(result), 'utf8');
    console.log(`\n  Shareable card written to ${outPath}`);
  } catch (error) {
    console.log(
      `\n  (could not write share card SVG: ${(error as Error).message})`,
    );
  }

  console.log(`\n  Share it:\n  ${renderSocialSnippet(result)}\n`);

  // Disambiguate the grade letter from the showcase badge tier — they both top
  // out at "A+" but mean different things, which reliably confuses first-timers.
  console.log(
    `  Note: this letter is your policy config's conformance grade (computed\n` +
      `  locally). The public "Graded with standdown" showcase badge is a separate\n` +
      `  tier — a config-verified submission publishes as an A badge (your\n` +
      `  ${result.score}/100 shown alongside); the A+ badge requires Tier 2 live-verify\n` +
      `  of your published extension. See showcase/README.md.\n`,
  );
}
