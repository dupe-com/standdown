---
description: Set up standdown in this browser extension — install, integrate, and grade it (auto-detects greenfield vs. brownfield).
---

Set up **standdown** (npm package `standdown`, source
https://github.com/dupe-com/standdown) in this browser extension so it stops
hijacking affiliate attribution a partner already owns, then grade and verify it.

Read and follow, end to end, the greenfield playbook at
`${CLAUDE_PLUGIN_ROOT}/AGENTS.md` — or, if that path isn't available, fetch
https://raw.githubusercontent.com/dupe-com/standdown/main/AGENTS.md. It detects
whether this is a fresh install or a migration of existing stand-down logic and
branches to `ADOPTING.md` (`/standdown:adopt`) accordingly.

When you're done, report my conformance grade and keep fixing until it's an A or
better. Preserve the invariants: decisions stay local and synchronous (no network
in the decision path), signals exclude user identity, and everything fails toward
standing down.
