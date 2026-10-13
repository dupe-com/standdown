// selfClickLift through the relay in a real browser: the host's own CJ click
// (cjevent=own-click, stripped by the page) ends a competitor's earlier CJ
// stand-down, and nothing else.
//
//   EXTRA_CASES=examples/relay-extension/e2e/cases/self-click-lift.mjs \
//     node examples/relay-extension/e2e/run.mjs
//
// The base scenarios still run with this config; none of them carries an own
// click, so they must pass unchanged.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default ({ u }) => ({
  capture: join(here, 'self-click-lift-capture.js'),
  background: join(here, 'self-click-lift-background.js'),
  scenarios: [
    {
      name: "lift: competitor's CJ click, then our CJ click (both stripped) -> clear",
      steps: [u('l1.example', '/strip?cjevent=abc'), u('l1.example', '/strip?cjevent=own-click')],
      expect: { relay: false },
    },
    {
      name: 'lift: stays clear on the next page of the visit',
      steps: [
        u('l2.example', '/strip?cjevent=abc'),
        u('l2.example', '/strip?cjevent=own-click'),
        u('l2.example', '/clean'),
      ],
      expect: { relay: false },
    },
    {
      name: "lift: our CJ click, then a competitor's CJ click -> stands down",
      steps: [u('l3.example', '/strip?cjevent=own-click'), u('l3.example', '/strip?cjevent=abc')],
      expect: { relay: true },
    },
    {
      name: "lift: competitor's Impact click, then our CJ click -> still stands down (other network)",
      steps: [u('l4.example', '/strip?irclickid=abc'), u('l4.example', '/strip?cjevent=own-click')],
      expect: { relay: true },
    },
    {
      name: 'lift: our own click alone -> clear (exempt as before)',
      steps: [u('l5.example', '/strip?cjevent=own-click')],
      expect: { relay: false },
    },
  ],
});
