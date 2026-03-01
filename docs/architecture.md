# aigentry Architecture

## Overview

aigentry is a three-pillar ecosystem for sovereign AI agents:

```
┌─────────────────────────────────────────────────┐
│                   AI Agent                       │
│                                                  │
│   ┌──────────┐  ┌──────────────┐  ┌──────────┐ │
│   │  Brain    │  │ Deliberation │  │ Registry │ │
│   │  Memory   │◄─┤  Multi-AI    │──┤  Eval &  │ │
│   │  MCP      │  │  Debate      │  │  Evolve  │ │
│   └──────────┘  └──────────────┘  └──────────┘ │
│     #d4a574        #8b5cf6          #ec4899      │
└─────────────────────────────────────────────────┘
```

## Components

### aigentry-brain
- **Role**: Structured memory MCP server
- **Protocol**: Model Context Protocol (MCP)
- **Storage**: Persistent, queryable memory graphs
- **Color**: Gold `#d4a574`

### aigentry-deliberation
- **Role**: Multi-AI deliberation framework
- **Participants**: Claude, Codex, Gemini, and more via CLI/browser
- **Output**: Synthesized consensus from structured debate
- **Color**: Purple `#8b5cf6`

### aigentry-registry
- **Role**: Agent evaluation and evolution platform
- **Features**: Agent tracking, comparison, evolution metrics
- **Frontend**: React + MorphAnimation braille particle system
- **Color**: Pink `#ec4899`

## Data Flow

1. **Agent** queries **Brain** for memory context
2. **Agent** enters **Deliberation** with context-informed prompts
3. **Deliberation** consensus feeds into **Registry** evaluation
4. **Registry** evolved agent configs feed back to **Brain**

## Design Principles

- **Sovereignty**: Agents own their memory and decisions
- **Interoperability**: Standard protocols (MCP) over proprietary APIs
- **Evolution**: Continuous improvement through evaluation loops
