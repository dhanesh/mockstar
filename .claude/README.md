# `.claude/` — agent harness config

`settings.json` is the **checked-in, least-privilege permission policy** for coding
agents (Claude Code) working in this repo. It implements the "scoped trusted tools"
rail (R5) from the agent-readiness audit: an agent gets the fast verify loop for free
and must stop for a human on anything consequential or irreversible.

## Policy at a glance

- **`allow`** — auto-approved. The read-only + verify surface an agent needs to run
  its loop without friction: `bun run verify`, tests, lint, typecheck, build, bench,
  `bun install`, and read-only `git` (`status`/`diff`/`log`/`show`/`branch`/`fetch`).
- **`ask`** — prompt a human every time. Outward-facing or environment-mutating
  actions that are sometimes legitimate: `git push`, `gh pr create`/`merge`,
  `docker build`/`run`, and `WebFetch`.
- **`deny`** — hard-blocked, no prompt. Irreversible or privileged actions an agent
  must never take unattended; a human runs these by hand:
  - `sudo`, `rm -rf`, force-push
  - publishing (`npm`/`bun publish`) and `gh release` — releases are automated via
    `semantic-release`, never hand-run by an agent
  - the HTTPS proxy installer/uninstaller (`proxy install`/`uninstall`, `make
    proxy-install`) — these touch the system CA store, DNS, and port-bind grants
  - `make clean-all` (nukes `node_modules` + Docker images)
  - reading `.env` / `.env.local` (secrets)

## Editing

- Keep the `allow` list scoped to genuinely safe, read-only-or-reversible commands.
- Anything that touches production, secrets, the host system, or publishes an
  artifact belongs in `deny` (or `ask` if a human should decide case by case).
- Per-user overrides go in `.claude/settings.local.json` (git-ignored), never here.

See `CONTRIBUTING.md` for the human contributor workflow; this file governs agents.
