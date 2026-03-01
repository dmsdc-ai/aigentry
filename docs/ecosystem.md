# aigentry Ecosystem

## Repository Map

| Repository | Description | Tech Stack |
|-----------|-------------|------------|
| [aigentry](https://github.com/aigentry/aigentry) | Ecosystem hub, brand, docs | Markdown |
| [aigentry-brain](https://github.com/aigentry/aigentry-brain) | Structured memory MCP server | TypeScript, MCP |
| [aigentry-deliberation](https://github.com/aigentry/aigentry-deliberation) | Multi-AI deliberation framework | TypeScript, MCP |
| [aigentry-registry](https://github.com/aigentry/aigentry-registry) | Agent evaluation & evolution | TypeScript, React, Next.js |

## How They Connect

```
Brain ←──── provides memory context ────→ Deliberation
  ↑                                            │
  │                                            ↓
  └──── evolved configs ──── Registry ←── consensus
```

## Shared Conventions

- **Language**: TypeScript
- **Protocol**: MCP (Model Context Protocol)
- **Brand Colors**: Gold (#d4a574), Cyan (#06b6d4), Purple (#8b5cf6)
- **Mascot**: `·⣿·`
