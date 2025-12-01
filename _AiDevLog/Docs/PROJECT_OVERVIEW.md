# Agentic Planning Coordinator (APC) - Project Overview

## What is APC?

The **Agentic Planning Coordinator** is a VS Code/Cursor extension that enables multi-agent AI planning and execution for software development, with specific support for Unity game development workflows.

## Core Concept

APC implements a **hierarchical multi-agent system** where:

1. **Users** provide natural language requirements
2. **Planning Agents** (Opus, Codex, Gemini) debate and create optimal execution plans
3. **A Coordinator Agent** manages task execution and monitors progress
4. **Engineer Agents** implement individual tasks in parallel
5. **Unity Control Manager** handles Unity-specific compilation and testing

```
┌─────────────────────────────────────────────────────────────┐
│                         USER                                 │
│                    (Natural Language)                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    PLANNING PHASE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Opus 4.5    │  │ Codex       │  │ Gemini 3    │         │
│  │ Analyst     │  │ Analyst     │  │ Analyst     │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         └────────────────┼────────────────┘                 │
│                          ▼                                   │
│                  CONSENSUS PLAN                              │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   EXECUTION PHASE                            │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    COORDINATOR                          ││
│  │              (Task Dispatch & Monitoring)               ││
│  └─────────────────────────────────────────────────────────┘│
│         │           │           │           │                │
│         ▼           ▼           ▼           ▼                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Engineer │ │ Engineer │ │ Engineer │ │ Engineer │        │
│  │  "Alex"  │ │  "Betty" │ │  "Cleo"  │ │  "Dany"  │        │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. Multi-Model Planning
- Spawn multiple AI analysts (Claude Opus, Codex, Gemini) to debate requirements
- Each analyst provides independent analysis and recommendations
- System builds consensus from multiple perspectives
- Creates detailed execution plans with task dependencies

### 2. Parallel Execution
- Coordinate multiple AI engineers working simultaneously
- Dynamic task dispatch based on dependency resolution
- Intelligent scaling: request/release agents as needed

### 3. Agent Pool Management
- Pool of named agents (Alex, Betty, Cleo, Dany, Echo, etc.)
- Role-based assignments (Engineer, Reviewer, Context Updater)
- Status tracking (available, busy, paused, error)

### 4. Unity Integration
- Built-in Unity compilation checking
- PlayMode/EditMode test execution
- Console error monitoring
- MCP (Model Context Protocol) for Unity Editor interaction

### 5. CLI Interface
- Full CLI (`apc`) for AI agent interaction
- Enables agents to manage their own workflow
- State file access for real-time status

### 6. Live Progress Tracking
- Real-time status updates via TreeViews
- State files readable by external tools
- Progress logs for each session

## Project Structure

```
Agentic-Planning-Coordinator/
├── src/
│   ├── extension.ts           # VS Code extension entry point
│   ├── cli/
│   │   └── CliHandler.ts      # CLI command handler
│   ├── services/
│   │   ├── StateManager.ts    # Persistent state management
│   │   ├── AgentPoolService.ts # Agent allocation
│   │   ├── AgentRoleRegistry.ts # Role configuration
│   │   ├── CoordinatorService.ts # Task coordination
│   │   ├── PlanningService.ts # Multi-agent planning
│   │   ├── TerminalManager.ts # VS Code terminal management
│   │   ├── UnityControlManager.ts # Unity integration
│   │   └── ...
│   ├── types/
│   │   ├── index.ts           # Core type definitions
│   │   └── unity.ts           # Unity-specific types
│   └── ui/
│       ├── SidebarViewProvider.ts # Main sidebar UI
│       └── ...
├── resources/
│   ├── UnityBestPractices.md  # Best practices for Unity
│   └── templates/
│       └── skeleton_plan.md   # Plan template
├── scripts/
│   ├── apc                    # CLI wrapper script
│   └── ...
└── _AiDevLog/                 # Working directory
    ├── Plans/                 # Planning session data
    ├── Context/               # Project context files
    ├── Docs/                  # Documentation
    └── Roles/                 # Custom role configs
```

## Technology Stack

- **Language**: TypeScript
- **Platform**: VS Code Extension API
- **AI Backends**: Cursor CLI (wraps Claude, GPT, Gemini)
- **Unity**: Unity MCP for Editor control
- **IPC**: WebSocket for CLI ↔ Extension communication

## Version

Current Version: **0.1.0**

## License

MIT License

## Author

Yu Gao (GAOS)

