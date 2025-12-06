# Agentic Planning Coordinator

A VS Code/Cursor extension for multi-agent AI planning and execution, designed for Unity game development workflows.

## Features

- **Multi-Model Planning**: Spawn multiple AI analysts (Opus, Codex, Gemini) to debate and create optimal plans
- **Parallel Execution**: Coordinate multiple AI engineers working on tasks simultaneously
- **Engineer Pool Management**: Configure and manage a pool of AI engineers
- **Named Terminals**: Each engineer gets a dedicated, named terminal for monitoring
- **Live Progress Tracking**: Real-time status updates via TreeViews and state files
- **CLI Interface**: Full CLI for AI agent interaction
- **Unity Integration**: Built-in support for Unity compilation checks and playmode tests

## Installation

### Prerequisites

Before installing the extension, ensure you have **BOTH Cursor CLI tools** installed:

```bash
# Check if Cursor CLI is installed
cursor --version

# Check if Cursor Agent CLI is installed (REQUIRED)
cursor-agent --version

# If either is missing, use our checking/installation scripts:
# Windows: .\scripts\check-cursor-cli.ps1
# Unix-like: ./scripts/check-cursor-cli.sh
```

📖 **See [Cursor CLI Installation Guide](Documentation/CURSOR_CLI_INSTALLATION.md) for detailed setup instructions**

### From VSIX (Recommended for Development)

1. Build the extension:
   ```bash
   cd Agentic-Planning-Coordinator
   npm install
   npm run compile
   npm run package
   ```

2. Install in VS Code/Cursor:
   - Open Extensions view (Cmd+Shift+X)
   - Click "..." menu → "Install from VSIX..."
   - Select the generated `.vsix` file

### From Source (Development)

1. Clone the repository
2. Run `npm install`
3. Press F5 to launch Extension Development Host

### Dependency Checking

Run automated dependency checks:

**Windows:**
```powershell
.\scripts\check-cursor-cli.ps1          # Basic check
.\scripts\check-cursor-cli.ps1 -Verbose  # Detailed info
```

**macOS / Linux / WSL:**
```bash
./scripts/check-cursor-cli.sh          # Basic check
./scripts/check-cursor-cli.sh --verbose # Detailed info
```

These scripts verify:
- ✅ Cursor CLI (required)
- ✅ Cursor Agent CLI (required)
- ✅ Node.js and npm
- ✅ MCP configuration
- ✅ Platform-specific tools

## Usage

### For Users (via GUI)

1. Open the **Agentic Planning** panel in the Activity Bar
2. Click "+" to start a new planning session
3. Enter your requirement
4. Review the generated plan
5. Approve and execute

### For AI Agents (via CLI)

The extension provides a CLI interface for AI agent interaction:

```bash
# Check overall status
agentic status

# Start planning
agentic plan start --prompt "Implement a combo system"

# Check planning status
agentic plan status --id ps_001

# Approve plan
agentic plan approve --id ps_001

# Start execution
agentic coordinator start --plan-session ps_001 --mode auto

# Monitor progress
agentic coordinator status --id coord_001

# View engineer logs
agentic engineer log --name Alex --lines 50

# Control engineers
agentic engineer pause --name Alex
agentic engineer resume --name Alex
agentic engineer terminal --name Alex

# Check Unity compilation
agentic unity compile
```

## Configuration

Settings can be configured via VS Code Settings or the Settings UI:

| Setting | Default | Description |
|---------|---------|-------------|
| `agenticPlanning.engineerPoolSize` | 5 | Total engineers in pool |
| `agenticPlanning.defaultBackend` | cursor | AI backend (cursor, claude-code, codex) |
| `agenticPlanning.workingDirectory` | _AiDevLog | Working directory for plans/logs |
| `agenticPlanning.autoOpenTerminals` | true | Auto-open terminals for engineers |
| `agenticPlanning.stateUpdateInterval` | 5000 | State file update interval (ms) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         USER                                 │
│                    (Natural Language)                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      AI AGENT                                │
│                  (Claude/Cursor)                             │
│         Uses CLI commands + reads state files                │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              AGENTIC PLANNING EXTENSION                      │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Planning   │  │ Coordinator │  │  Engineer   │         │
│  │  Service    │  │  Service    │  │   Pool      │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Terminal   │  │   State     │  │    CLI      │         │
│  │  Manager    │  │  Manager    │  │  Handler    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## State Files

The extension maintains state in JSON files for AI agent access:

```
_AiDevLog/
├── .extension_state.json      # Global settings, active sessions
├── .engineer_pool.json        # Pool allocation
├── coordinators/
│   └── coord_001.json         # Individual coordinator state
├── Plans/
│   └── ps_001/
│       ├── plan.md            # Generated plan
│       └── progress.log       # Planning progress log
├── Context/                   # Project context files
├── Docs/                      # Project documentation
├── Errors/                    # Error registry
└── Logs/
    └── engineers/
        └── Alex_session_xxx.log
```

## Development

### Building

```bash
npm install
npm run compile
```

### Testing

```bash
npm run test
```

### Packaging

```bash
npm run package
```

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines first.










