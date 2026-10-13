// The CJ "session, or at least N minutes" rule across a real browser restart,
// with N shortened to 8 s (see session-floor-background.js).
//
//   EXTRA_CASES=examples/relay-extension/e2e/cases/session-floor.mjs \
//     node examples/relay-extension/e2e/run.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default ({ u }) => ({
  background: join(here, 'session-floor-background.js'),
  scenarios: [
    {
      name: 'floor: referral, restart right away -> still stands down',
      steps: [u('f1.example', '/strip?cjevent=abc'), 'RESTART', u('f1.example', '/clean')],
      expect: { relay: true },
    },
    {
      name: 'floor: referral, restart after the floor -> clear',
      steps: [u('f2.example', '/strip?cjevent=abc'), { waitMs: 9_000 }, 'RESTART', u('f2.example', '/clean')],
      expect: { relay: false },
    },
    {
      // Referral at 0 s and again at ~5 s; restart at ~10 s. 8 s from the first
      // referral has passed, 8 s from the latest has not.
      name: 'floor: second referral re-arms it -> still stands down after restart',
      steps: [
        u('f3.example', '/strip?cjevent=abc'),
        { waitMs: 5_000 },
        u('f3.example', '/strip?cjevent=def'),
        { waitMs: 5_000 },
        'RESTART',
        u('f3.example', '/clean'),
      ],
      expect: { relay: true },
    },
  ],
});
