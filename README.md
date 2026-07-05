<div align="center">

# aigentry

**One command installs the entire aigentry ecosystem** — terminal, cross-session transport, persistent memory, and multi-AI deliberation for AI agents.

[![npm](https://img.shields.io/npm/v/@dmsdc-ai/aigentry?style=flat-square&color=d4a574)](https://www.npmjs.com/package/@dmsdc-ai/aigentry)
[![License: MIT](https://img.shields.io/badge/License-MIT-d4a574?style=flat-square)](LICENSE)

</div>

---

## Install

One command installs the entire ecosystem:

```bash
npm i -g @dmsdc-ai/aigentry
```

## Ecosystem

| Module | Package | Description |
|--------|---------|-------------|
| **aterm** | `@dmsdc-ai/aterm` | Terminal UI for AI agents |
| **telepty** | `@dmsdc-ai/aigentry-telepty` | Session transport + inter-session communication |
| **devkit** | `@dmsdc-ai/aigentry-devkit` | Installer, orchestrator, and CLI tooling |
| **brain** | `@dmsdc-ai/aigentry-brain` | Persistent structured memory (MCP server) |
| **deliberation** | `@dmsdc-ai/aigentry-deliberation` | Multi-AI structured debate (MCP server) |

## Usage

```bash
# Check ecosystem status
aigentry status

# Show version
aigentry version

# Show help
aigentry help
```

## Architecture

```mermaid
graph LR
    subgraph aigentry Ecosystem
        A[aterm<br/>Terminal UI]
        T[telepty<br/>Session Transport]
        K[devkit<br/>Installer & CLI]
        B[brain<br/>Structured Memory MCP]
        D[deliberation<br/>Multi-AI Debate]
    end

    Agent((AI Agent)) --> A
    A --> T
    T --> B
    T --> D
    K -->|provisions| A
    K -->|provisions| T
    K -->|provisions| B
    K -->|provisions| D
    B -->|memory context| D
    D -->|consensus| B

    style A fill:#f59e0b,stroke:#d97706,color:#000
    style T fill:#10b981,stroke:#059669,color:#000
    style K fill:#d4a574,stroke:#b8956a,color:#000
    style B fill:#06b6d4,stroke:#0891b2,color:#000
    style D fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style Agent fill:#ef4444,stroke:#dc2626,color:#fff
```

## What this is

aigentry is a meta-package. `npm i -g @dmsdc-ai/aigentry` installs and version-checks the whole stack — [aterm](https://github.com/dmsdc-ai/aterm), [telepty](https://github.com/dmsdc-ai/aigentry-telepty), [devkit](https://github.com/dmsdc-ai/aigentry-devkit), [brain](https://github.com/dmsdc-ai/aigentry-brain), and [deliberation](https://github.com/dmsdc-ai/aigentry-deliberation) — behind one CLI. Each module is independently useful and separately published; this package just wires them together and reports status via `aigentry status`.

- **Remember** — persistent structured memory across sessions (brain)
- **Deliberate** — multi-model debate before deciding (deliberation)
- **Connect** — cross-session, cross-machine transport (telepty)

## Brand Assets

Logos, mascot, color palette, and social media assets are in [`/brand`](./brand/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - See [LICENSE](LICENSE) for details.
