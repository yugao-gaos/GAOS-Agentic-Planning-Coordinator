# Agentic Planning Coordinator - Documentation

This folder contains comprehensive documentation for the Agentic Planning Coordinator (APC) VS Code/Cursor extension.

## Overview

APC is a multi-agent AI planning and execution system designed for Unity game development workflows. It orchestrates multiple AI agents to collaboratively plan and implement features through a daemon-based architecture.

## Documentation Index

### Architecture

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level system architecture, client-daemon split, communication patterns |
| [DAEMON_SYSTEM.md](./DAEMON_SYSTEM.md) | WebSocket daemon server, lifecycle, configuration |
| [CLIENT_SYSTEM.md](./CLIENT_SYSTEM.md) | VS Code extension, client interfaces, connection management |
| [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md) | State files, StateManager, persistence |

### Core Features

| Document | Description |
|----------|-------------|
| [AGENT_POOL.md](./AGENT_POOL.md) | Agent lifecycle states (available, resting, allocated, busy) |
| [WORKFLOW_SYSTEM.md](./WORKFLOW_SYSTEM.md) | All 5 workflow types and their phases |
| [COORDINATOR.md](./COORDINATOR.md) | Event-driven coordination and decision making |
| [UNITY_INTEGRATION.md](./UNITY_INTEGRATION.md) | Unity-specific features and workflows |

### Reference

| Document | Description |
|----------|-------------|
| [API_REFERENCE.md](./API_REFERENCE.md) | WebSocket protocol, requests, responses |
| [CLI_REFERENCE.md](./CLI_REFERENCE.md) | APC command line interface reference |
| [CONFIGURATION.md](./CONFIGURATION.md) | Daemon configuration and settings |
| [UI_COMPONENTS.md](./UI_COMPONENTS.md) | Sidebar, panels, webview components |

### Development

| Document | Description |
|----------|-------------|
| [BEST_PRACTICES.md](./BEST_PRACTICES.md) | Core development principles (no fallback logic, explicit errors, etc.) |

## Quick Start

### For Users

1. Install the extension in VS Code/Cursor
2. Open the **Agentic Planning** panel in the Activity Bar
3. Click "+" to start a new planning session
4. Enter your requirement and let the AI create a plan
5. Review, approve, and execute

### For AI Agents (CLI)

```bash
# Start planning
apc plan new "Implement a combo system"

# Check status
apc plan status <session-id>

# Approve and execute
apc plan approve <session-id>

# Monitor progress
apc exec status <session-id>
```

## Key Concepts

### Client-Daemon Architecture

```
┌─────────────────────┐     WebSocket     ┌─────────────────────┐
│   VS Code/Cursor    │◄──────────────────►│    APC Daemon       │
│   (GUI Client)      │                    │   (Business Logic)  │
└─────────────────────┘                    └─────────────────────┘
         │                                           │
         │                                           │
         ▼                                           ▼
┌─────────────────────┐                    ┌─────────────────────┐
│  Terminal/Webview   │                    │  State Files        │
│  UI Components      │                    │  _AiDevLog/         │
└─────────────────────┘                    └─────────────────────┘
```

### Agent States

```
available ──► allocated (bench) ──► busy
    ▲              │                 │
    │              │                 │
    └── resting ◄──┴─────────────────┘
        (5s cooldown)
```

### Workflow Types

1. **Planning New** - Multi-agent debate to create execution plans
2. **Planning Revision** - Revise existing plans with feedback
3. **Task Implementation** - Execute individual tasks from plans
4. **Error Resolution** - Handle and resolve errors
5. **Context Gathering** - Collect project context for planning

## Project Structure

```
src/
├── daemon/           # WebSocket server & API handling
├── client/           # Client interfaces & protocols
├── services/         # Core business logic
│   └── workflows/    # Workflow implementations
├── types/            # TypeScript type definitions
├── ui/               # UI components & webviews
├── utils/            # Utilities (Logger, etc.)
└── vscode/           # VS Code-specific integrations
```

## Runtime Directory

When running, APC creates a working directory (default: `_AiDevLog/`) containing:

```
_AiDevLog/
├── .config/           # Daemon configuration
│   └── daemon.json   # Port, backend, pool size, etc.
├── Plans/             # Generated plans
├── Logs/              # Agent logs
│   ├── daemon.log    # Daemon system log
│   └── engineers/    # Individual engineer logs
├── Context/           # Project context files
├── Errors/            # Error registry
└── coordinators/      # Coordinator state
```

## License

MIT - See [LICENSE](../LICENSE) for details.
