<div align="center">

# aigentry

**An AI Development Runtime.** One meta-package installs the ecosystem that transports prompts across terminals and machines, deliberates across models, persists memory, and scaffolds the whole AI dev environment.

[![npm](https://img.shields.io/npm/v/@dmsdc-ai/aigentry?style=flat-square&color=d4a574)](https://www.npmjs.com/package/@dmsdc-ai/aigentry)
[![License: MIT](https://img.shields.io/badge/License-MIT-d4a574?style=flat-square)](LICENSE)

</div>

---

`@dmsdc-ai/aigentry` is the **ecosystem meta-installer** — one command pulls in the working modules and reports their status behind a single CLI. Each module is **independently published and independently useful**; the hub just wires them together. The flagship, **telepty**, is shipping and runs standalone (it does not depend on the hub or the orchestrator). The rest are earlier — see [Maturity](#maturity-honest-scope).

## Quickstart

> **Source feature — not on npm yet.** The `doctor`, `start`, `restart` and component commands below exist in this repository's source (meta package 0.1.1) but are **not in a published npm release yet**. An `aigentry` installed from npm today may only offer `status`, `version` and `help`.

```bash
# Install the hub (Node.js >= 20.11.0)
npm i -g @dmsdc-ai/aigentry

aigentry status              # what's installed, where it resolves from, telepty service state
aigentry doctor              # health checks: exit 0 ok · 1 required check failed · 7 inconclusive
aigentry doctor --timeout 3000   # the same, finishing within one 3-second budget
aigentry doctor --json       # the same, as one JSON document on stdout
aigentry start               # start telepty if it isn't running (= aigentry start telepty)
aigentry restart telepty     # restart the daemon; lists sessions that won't survive and asks first
aigentry help                # commands and components
aigentry telepty list        # run a component's own CLI through the hub
aigentry devkit              # no arguments: prints help for devkit, runs nothing
```

| Command | What it does |
| --- | --- |
| `aigentry` · `aigentry status [--json]` | Each module's version, whether it resolves from your `PATH` or the hub's bundled copy, and telepty's service state. Always exits 0. `--json` prints one `aigentry.status/v1` document. |
| `aigentry doctor [--json] [--timeout <ms>]` | Health checks. Exit **0** = healthy · **1** = a required check failed · **7** = inconclusive (a required check could not be decided, e.g. the daemon did not answer in time). `--timeout` is one budget for the whole run (default 10000 ms, max 60000; each daemon probe gets at most 1500 ms of it). `--json` prints exactly one JSON document (`aigentry.doctor/v1`) on stdout. |
| `aigentry start [telepty] [--port <n>]` | `telepty` is the default. Already running → exit 0. If telepty's service supervisor is installed for that port, the hub asks it to start the daemon (for a root systemd unit it only prints the `sudo` command); otherwise it runs telepty's own `telepty daemon start`. Then it waits for the daemon's health check. If a supervisor is installed but the port it serves cannot be determined (see **Supervisor ports** below), it starts nothing and exits 1. |
| `aigentry restart telepty [--port <n>] [--yes]` | Restarts the daemon. Sessions made with `telepty spawn` die with it (wrapped `telepty allow` sessions survive), so it lists those first and asks for confirmation — pass `--yes` when there is no terminal to ask in. Refused inside an agent session (advisory), when the daemon's state is unknown, when the supervisor's port is unknown, when telepty's restart lease is held or unreadable, and when the running daemon cannot be identified by its authenticated `/api/meta` on that port (no token, token refused, no or malformed answer, another port, no pid) — `--yes` or answering `y` does not override this. A refusal runs nothing (exit 4 inside an agent session, otherwise 1). Once the restart action has run, it reports success (exit 0) only when `/api/meta` on that port shows a new pid; otherwise it exits 1 (UNCONFIRMED): the daemon may already have been restarted, so exit 1 alone does not mean nothing happened — check `aigentry doctor` before retrying. |
| `aigentry start orchestrator [--workspace <path>]`<br>`aigentry restart orchestrator [--workspace <path>]` | Runs your control workspace's boot in this terminal — see [Orchestrator launch](#orchestrator-launch-macos--linux). macOS / Linux only. |
| `aigentry <component> [args…]` | Runs that component's own CLI with your arguments; its exit code is returned unchanged. With **no** arguments it prints help for the component and runs nothing. Components: `telepty`, `orchestrator` (if on `PATH`), `devkit`, `brain`, `deliberation` (`doctor`, `install`), `aterm`, `logger` (if `aigentry-logger` is on `PATH`). |
| `aigentry version` · `aigentry help [topic]` | Hub version · usage. |

`restart` always needs an explicit target (`telepty` or `orchestrator`). There is no `stop`, `repair` or `--all` in this version: stop the daemon with `telepty daemon stop` (a launchd/systemd-supervised daemon is brought back by its supervisor). Passthrough has the component's own side effects — e.g. `aigentry brain …` may self-update brain, exactly like `aigentry-brain …`.

**Supervisor ports.** `start`/`restart telepty` hand the daemon to its supervisor only when that supervisor's job serves the addressed port; when the port it serves is unknown they refuse and run nothing. The port is read from the launchd plist or the systemd unit file. A systemd unit with any `EnvironmentFile=` line, or with a nonempty or unreadable `<unit>.d/` drop-in directory next to it, counts as unknown; other systemd configuration locations (for example `/etc/systemd/user/` or `/run/systemd/`) are not inspected. The Windows scheduled task names no port: like telepty, the hub assumes it serves the default 3848, and it is never used for any other port.

**`status` and `doctor` are passive, local diagnostics.** They read local files and ask the local telepty daemon on `127.0.0.1` for its health. `status` sends **no** telepty token, so it reports the token and orchestrator-session checks as *skipped* (run `aigentry doctor`). `doctor` also checks the daemon's metadata and session list when a telepty token is configured; the token is only sent as a request header, never printed. They start **no** subprocesses: no component commands, no installs, no repairs. `doctor` lists the component doctors (`aigentry deliberation doctor`, `aigentry devkit doctor`, `aigentry brain doctor`) for you to run; it does not run them. On Windows the telepty scheduled task is not queried, so the supervisor may be reported as unknown.

**Versions are checked against this package's own ranges.** `doctor` reports a component whose running copy (the `PATH` copy wins over the bundled one) is outside the range this package declares as a failed required check, an unreadable version as inconclusive, and a `PATH` copy that differs from the bundled copy — or a daemon whose version differs from the CLI — as an advisory. `start`/`restart telepty` never run a telepty CLI outside the supported range.

**Optional or unsupported is not broken.** Only required checks decide `doctor`'s exit code. A stopped telepty daemon is a warning (`aigentry start` fixes it). A running daemon that this machine has no token for is a failure. Absent optional pieces — the orchestrator, its control workspace, aterm (optional everywhere; its app is macOS arm64 only), the logger — are reported as missing or unsupported, not as failures.

### Orchestrator launch (macOS / Linux)

`aigentry start orchestrator` and `aigentry restart orchestrator` run the control workspace's own `bin/orchestrator-boot.sh` as a **foreground child in the terminal you typed them in**, sharing that terminal's stdin/stdout/stderr — the boot wizard needs a human at the keyboard. Before running anything the hub checks:

- the control workspace — `--workspace <path>`, else `$AIGENTRY_CONTROL_WORKSPACE`, else `~/aigentry/_orchestrator` — already exists (create it with `aigentry-orchestrator init`) and contains `bin/orchestrator-boot.sh`;
- the standalone orchestrator package's `aigentry-orchestrator` command is on your `PATH` — the hub does **not** bundle or install it;
- the telepty daemon is running (`aigentry start` first), the orchestrator session's state can be read with your telepty token, and the terminal is interactive.

`start` refuses if an orchestrator is already live under the default session id (`$ORCHESTRATOR_SID`, else `orchestrator`) (use `restart`); on `restart`, the boot asks you to type `YES` before it replaces the running orchestrator. Both refuse when run from inside an agent session. That refusal is an advisory safety net, **not a security boundary**: the boot script and component commands stay directly runnable (and a bridge whose path contains spaces is not recognised by it). While the boot runs, Ctrl-C and Ctrl-\ reach the boot from your terminal; the hub forwards no signal and never kills anything itself. Orchestrator `start`/`restart` are **not supported on native Windows**.

**Platforms.** macOS and Linux are the primary targets. On native Windows, the portable parts — `status`, `doctor`, `help`/`version` and component passthrough — are meant to work wherever the component itself works, and `status`/`doctor` label each component: telepty is **beta**, brain has a **known defect**, devkit and deliberation are **unmeasured**; aterm's app is macOS arm64 only. Not every component works on every platform today.

You don't have to install everything — **any module can be installed on its own** (see each section below).

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

> The table is a snapshot generated from `ecosystem.json` (vendored from aigentry-devkit, last refreshed 2026-07-26). Its versions and publication flags — and the versions quoted in the module sections below — can lag npm. Run `aigentry status` to see what is actually installed.

How they relate: the **orchestrator** drives terminal sessions by pushing prompts through **telepty**, which transports them across machines; **deliberation** arbitrates when multiple sessions need to agree; **brain** carries memory across resets; **devkit** installs and configures the whole thing; **aterm** is one of the terminals sessions can run in.

---

## telepty — the flagship (shipping)

`@dmsdc-ai/aigentry-telepty` · **0.6.9** · MIT

A PTY orchestration daemon and session bridge for AI-CLI workflows: spawn, attach to, and inject prompts into terminal sessions — locally or **across machines over a Tailscale tailnet** with `<session>@<host>` addressing. A daemon/bridge split lets wrapped sessions survive daemon restarts; a render-gated `submit` presses Enter reliably across Claude Code, Codex, and Gemini CLI. Runs standalone — telepty-only users need nothing else in this list.

```bash
npm install -g @dmsdc-ai/aigentry-telepty      # or the curl/PowerShell installer

telepty daemon start                           # start the daemon in the background (:3848)
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

Repo: [`dmsdc-ai/aigentry-orchestrator`](https://github.com/dmsdc-ai/aigentry-orchestrator) · package `@dmsdc-ai/aigentry-orchestrator` (command `aigentry-orchestrator`) · *not bundled by the hub — installed separately*

The conductor that drives multi-session AI dispatch — it decides what work runs where and pushes prompts into sessions through telepty. The repository is public, but it is **ecosystem-internal orchestration infrastructure, not a public product**: the hub does not install it and there's no supported public API. `aigentry start orchestrator` only launches an existing control workspace (see [Orchestrator launch](#orchestrator-launch-macos--linux)).

---

## Maturity (honest scope)

The differentiator here is candor, not gloss. Real state today:

- **Shipping** — **telepty** (0.6.9). Battle-tested, standalone, cross-machine, with a documented "Limitations" section it stands behind.
- **Early** — **brain** (0.2.8), **deliberation** (0.0.47), **devkit** (0.0.22), **aterm** (0.2.14). Functional and published, but pre-1.0: surfaces and internals still move, and some features are explicitly unfinished (see each module's own README).
- **Internal** — **orchestrator**. Public repo, not bundled by the hub, no supported public API.

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
