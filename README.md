<div align="center">

# aigentry

**Sovereign Brain OS for AI Agents**

The open ecosystem where AI agents evolve, deliberate, and remember.

[![License: MIT](https://img.shields.io/badge/License-MIT-d4a574?style=flat-square)](LICENSE)
[![brain](https://img.shields.io/badge/brain-MCP_Server-06b6d4?style=flat-square)](https://github.com/aigentry/aigentry-brain)
[![deliberation](https://img.shields.io/badge/deliberation-Multi_AI_Debate-8b5cf6?style=flat-square)](https://github.com/aigentry/aigentry-deliberation)
[![registry](https://img.shields.io/badge/registry-Agent_Evolution-ec4899?style=flat-square)](https://github.com/aigentry/aigentry-registry)

</div>

---

## Architecture

```mermaid
graph LR
    subgraph aigentry Ecosystem
        B[aigentry-brain<br/>Structured Memory MCP]
        D[aigentry-deliberation<br/>Multi-AI Debate]
        R[aigentry-registry<br/>Agent Eval & Evolution]
    end

    Agent((AI Agent)) --> B
    Agent --> D
    Agent --> R
    B -->|memory context| D
    D -->|consensus| R
    R -->|evolved agents| B

    style B fill:#06b6d4,stroke:#0891b2,color:#000
    style D fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style R fill:#ec4899,stroke:#db2777,color:#fff
    style Agent fill:#d4a574,stroke:#b8956a,color:#000
```

## Ecosystem

| Project | Description | Status |
|---------|-------------|--------|
| [aigentry-brain](https://github.com/aigentry/aigentry-brain) | Structured memory MCP server. Persistent, queryable memory for AI agents. | Active |
| [aigentry-deliberation](https://github.com/aigentry/aigentry-deliberation) | Multi-AI deliberation framework. Structured debates between Claude, Codex, Gemini, and more. | Active |
| [aigentry-registry](https://github.com/aigentry/aigentry-registry) | Agent evaluation and evolution platform. Track, compare, and evolve AI agents. | Active |

## Vision

aigentry is building the infrastructure layer for autonomous AI agents:

- **Remember** — Structured, persistent memory that survives across sessions
- **Deliberate** — Multi-model debates that surface better decisions
- **Evolve** — Continuous evaluation and improvement of agent capabilities

The goal: AI agents that are not disposable prompt-followers, but sovereign entities with memory, judgment, and growth.

## Quick Start

```bash
# Install aigentry-brain (MCP server)
npx aigentry-brain

# Start a multi-AI deliberation
npx aigentry-deliberation start --topic "System design review"

# Launch the registry
cd aigentry-registry && npm run dev
```

## Brand Assets

Logos, mascot, color palette, and social media assets are in [`/brand`](./brand/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - See [LICENSE](LICENSE) for details.
