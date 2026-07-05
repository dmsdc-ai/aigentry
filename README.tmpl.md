<div align="center">

# aigentry

**An AI Development Runtime.** One meta-package installs the ecosystem that transports prompts across terminals and machines, deliberates across models, persists memory, and scaffolds the whole AI dev environment.

[![npm](https://img.shields.io/npm/v/@dmsdc-ai/aigentry?style=flat-square&color=d4a574)](https://www.npmjs.com/package/@dmsdc-ai/aigentry)
[![License: MIT](https://img.shields.io/badge/License-MIT-d4a574?style=flat-square)](LICENSE)

</div>

---

`@dmsdc-ai/aigentry` is the **ecosystem meta-installer** — one command pulls in the working modules and reports their status behind a single CLI. Each module is **independently published and independently useful**; the hub just wires them together. The flagship, **telepty**, is shipping and runs standalone (it does not depend on the hub or the orchestrator). The rest are earlier — see [Maturity](#maturity-honest-scope).

## Quickstart

```bash
# Install the whole ecosystem
npm i -g @dmsdc-ai/aigentry

# Check what's installed
aigentry status
```

`aigentry status` version-checks each module and prints a table:

```
  Module           Version     CLI
  ───────────────  ──────────  ───────
  ✓ aterm            v0.2.14     ✓
  ✓ telepty          v0.6.9      ✓
  ✓ devkit           v0.0.22     ✓
  ✓ brain            v0.2.8      —
  ✓ deliberation     v0.0.47     —

  5/5 modules installed
```

Other hub commands: `aigentry version`, `aigentry help`. You don't have to install everything — **any module can be installed on its own** (see each section below).

## Ecosystem

```
                 ┌──────────────────────────────────────────────┐
                 │  orchestrator — control tower (internal)      │
                 │  drives sessions, dispatches work             │
                 └───────────────────┬──────────────────────────┘
                                     │  inject / broadcast
                                     ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  telepty — PTY orchestration daemon (:3848)                        │
   │  transports prompts across terminals & machines   <id>@<host>      │
   └───┬────────────────────┬─────────────────────┬────────────────────┘
       │                    │                     │
       ▼                    ▼                     ▼
  AI-CLI sessions      deliberation            brain
  (claude / codex /    (MCP: multi-AI          (MCP: cross-session
   gemini / aterm)      debate + synthesis)     memory, 26 tools)

  devkit — installs the dev environment (skills · hooks · MCP · HUD/statusline)
```

{{ecosystem_table}}

How they relate: the **orchestrator** drives terminal sessions by pushing prompts through **telepty**, which transports them across machines; **deliberation** arbitrates when multiple sessions need to agree; **brain** carries memory across resets; **devkit** installs and configures the whole thing; **aterm** is one of the terminals sessions can run in.

---

## telepty — the flagship (shipping)

`@dmsdc-ai/aigentry-telepty` · **0.6.9** · MIT

A PTY orchestration daemon and session bridge for AI-CLI workflows: spawn, attach to, and inject prompts into terminal sessions — locally or **across machines over a Tailscale tailnet** with `<session>@<host>` addressing. A daemon/bridge split lets wrapped sessions survive daemon restarts; a render-gated `submit` presses Enter reliably across Claude Code, Codex, and Gemini CLI. Runs standalone — telepty-only users need nothing else in this list.

```bash
npm install -g @dmsdc-ai/aigentry-telepty      # or the curl/PowerShell installer

telepty daemon                                 # start the background daemon (:3848)
telepty allow --id claude-main claude          # wrap a CLI for remote inject
telepty list                                   # sessions across the tailnet
telepty inject claude-main "refactor auth"     # inject a prompt
telepty inject --submit claude-main "run it"   # inject + gated Enter
telepty broadcast "status report"              # fan out to every session
```

telepty is deliberately **not** a terminal multiplexer — it does no VT emulation, cell grid, or copy-mode; screen reads are buffered bytes plus heuristic state, and it requires a background daemon on an auth-gated port (:3848). Use tmux for terminal fidelity; use telepty when software needs to operate many sessions over an API. Full command surface, honest limitations, and the cross-machine trust model are in its [README](https://github.com/dmsdc-ai/aigentry-telepty).

## brain — persistent memory (early)

`@dmsdc-ai/aigentry-brain` · **0.2.8** · MIT

An MCP server giving agents structured memory that survives context resets. Exposes 26 MCP tools so Claude Code (and any MCP client) can read/write memories, sync them across machines via Git, and attach policy metadata for scope and retention. Local-first by default; cross-device sync is opt-in after explicit consent.

```bash
npm install -g @dmsdc-ai/aigentry-brain        # registers the MCP server automatically
aigentry-brain-mcp                             # run the MCP server manually
```

Known gaps (from its README): team-scope access control isn't enforced yet, and the `retention_ttl` auto-expiry sweeper isn't implemented (expired entries are filtered at read time, not physically removed).

## deliberation — multi-AI debate (early)

`@dmsdc-ai/aigentry-deliberation` · **0.0.47** · MIT

An MCP server for structured multi-AI discussions: pose a topic, route turns across CLI agents (Claude Code, Codex, Gemini) and browser LLMs (ChatGPT, Claude Web, Gemini Web), collect `[AGREE]`/`[DISAGREE]`/`[CONDITIONAL]` votes, and synthesize a typed decision envelope — with full audit trails.

```bash
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-install   # register with Claude Code / Gemini
npx --yes --package @dmsdc-ai/aigentry-deliberation deliberation-doctor    # diagnostics
```

## devkit — dev-environment installer (early)

`@dmsdc-ai/aigentry-devkit` · **0.0.22** · MIT

One installer for your AI dev environment: bundles skills, session hooks, MCP servers, HUD/statusline, and config templates for Claude Code, Codex CLI, and other MCP-compatible CLIs.

```bash
npx --yes --package @dmsdc-ai/aigentry-devkit aigentry-devkit install
npx --yes --package @dmsdc-ai/aigentry-devkit aigentry-devkit profiles     # list install profiles
```

## aterm — terminal launcher (early)

`@dmsdc-ai/aterm` · **0.2.14** · *license: UNLICENSED*

A native terminal launcher with session IPC that integrates with the telepty bus. Bundled by the hub so sessions have a terminal to run in; also installable on its own.

```bash
npm install -g @dmsdc-ai/aterm
```

> Note: unlike the rest of the ecosystem (MIT), the published `@dmsdc-ai/aterm` package is marked **UNLICENSED**.

## orchestrator — control tower (internal)

Repo: [`dmsdc-ai/aigentry-orchestrator`](https://github.com/dmsdc-ai/aigentry-orchestrator) · *not published to npm*

The conductor that drives multi-session AI dispatch — it decides what work runs where and pushes prompts into sessions through telepty. The repository is public, but it is **ecosystem-internal orchestration infrastructure, not a public product**: there's no npm package to install and no supported public API.

---

## Maturity (honest scope)

The differentiator here is candor, not gloss. Real state today:

- **Shipping** — **telepty** (0.6.9). Battle-tested, standalone, cross-machine, with a documented "Limitations" section it stands behind.
- **Early** — **brain** (0.2.8), **deliberation** (0.0.47), **devkit** (0.0.22), **aterm** (0.2.14). Functional and published, but pre-1.0: surfaces and internals still move, and some features are explicitly unfinished (see each module's own README).
- **Internal** — **orchestrator**. Public repo, unpublished, no supported public API.

If a capability isn't listed above, assume it isn't there yet.

## Links

- npm: [`@dmsdc-ai/aigentry`](https://www.npmjs.com/package/@dmsdc-ai/aigentry) · [telepty](https://www.npmjs.com/package/@dmsdc-ai/aigentry-telepty) · [brain](https://www.npmjs.com/package/@dmsdc-ai/aigentry-brain) · [deliberation](https://www.npmjs.com/package/@dmsdc-ai/aigentry-deliberation) · [devkit](https://www.npmjs.com/package/@dmsdc-ai/aigentry-devkit) · [aterm](https://www.npmjs.com/package/@dmsdc-ai/aterm)
- GitHub: [aigentry](https://github.com/dmsdc-ai/aigentry) · [telepty](https://github.com/dmsdc-ai/aigentry-telepty) · [brain](https://github.com/dmsdc-ai/aigentry-brain) · [deliberation](https://github.com/dmsdc-ai/aigentry-deliberation) · [devkit](https://github.com/dmsdc-ai/aigentry-devkit) · [orchestrator](https://github.com/dmsdc-ai/aigentry-orchestrator)

## Brand Assets

Logos, mascot, color palette, and social media assets are in [`/brand`](./brand/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE). Individual modules carry their own licenses (all MIT except `@dmsdc-ai/aterm`, which is UNLICENSED).
