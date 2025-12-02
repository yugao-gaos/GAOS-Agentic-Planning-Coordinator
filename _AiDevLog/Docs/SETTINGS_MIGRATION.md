# Settings Architecture Migration

## Overview

The APC settings architecture has been consolidated to use **daemon-managed configuration** with a unified `.config/` directory structure. This eliminates redundancy and provides both CLI and GUI access to settings.

## Key Changes

### 1. Unified Config Location

**Before** (scattered):
```
_AiDevLog/
├── .cache/apc_config.json           ❌ Scattered
├── Config/                          ❌ Mixed location
│   ├── Roles/*.json
│   ├── SystemPrompts/*.json
│   └── workflow_settings.json
```

**After** (consolidated):
```
_AiDevLog/
├── .config/                         ✅ All config here
│   ├── daemon.json                  # Core daemon config
│   ├── folders.json                 # Folder structure
│   ├── roles/*.json                 # Agent roles
│   ├── system_prompts/*.json        # System prompts
│   ├── workflows.json               # Workflow settings
│   └── context_presets.json         # Context presets
├── .cache/                          ✅ Runtime only
│   └── (temp files, locks)
```

### 2. Removed Redundant Settings

The following VS Code extension settings have been **removed** and moved to daemon config:

- ❌ `agentPoolSize` → Use `apc config set agentPoolSize <N>` or Daemon Settings panel
- ❌ `useIterativePlanning` → Removed (workflow is always iterative)
- ❌ `enableUnityFeatures` → Use `apc config set enableUnityFeatures true/false`
- ❌ `stateUpdateInterval` → Use `apc config set stateUpdateInterval <ms>`
- ❌ `unityBestPracticesPath` → Use built-in + `_AiDevLog/Docs/` for custom docs

**Kept in VS Code settings** (bootstrap only):
- ✅ `workingDirectory` - Root folder (rarely changed)
- ✅ `defaultBackend` - AI backend ('cursor')
- ✅ `autoOpenTerminals` - UI-only behavior

### 3. Folder Structure Customization

**NEW FEATURE**: Customize subdirectory names within the working directory!

```bash
# View folder structure
apc config folders get

# Customize folder names
apc config folders set plans "MyPlans"
apc config folders set context "ProjectContext"

# Reset to defaults
apc config folders reset
```

Default structure:
```json
{
  "plans": "Plans",
  "tasks": "Tasks",
  "logs": "Logs",
  "context": "Context",
  "docs": "Docs",
  "errors": "Errors",
  "scripts": "Scripts",
  "history": "History",
  "notifications": "Notifications"
}
```

## CLI Commands

### Config Management

```bash
# Get all daemon config
apc config get

# Get specific key
apc config get agentPoolSize

# Set config value
apc config set agentPoolSize 15
apc config set enableUnityFeatures false
apc config set logLevel debug

# Reset to defaults
apc config reset agentPoolSize
apc config reset  # Reset all
```

### Folder Management

```bash
# View folder structure
apc config folders get

# View specific folder
apc config folders get plans

# Customize folder name
apc config folders set plans "MyPlans"

# Reset folders
apc config folders reset plans
apc config folders reset  # Reset all
```

## GUI Access

### Daemon Settings Panel

Open via:
- Command Palette: `APC: Daemon Settings`
- Command: `apc.openDaemonSettings`

Features:
- **General Tab**: Pool size, state interval, log level
- **Unity Tab**: Enable/disable Unity features
- **Folders Tab**: Customize folder structure with live preview
- **Advanced Tab**: Port, backend, view full config

### Other Settings Panels

- **Agent Roles**: `APC: Configure Agent Roles`
- **Workflow Settings**: Workflow coordinator prompts and context presets

## Daemon Configuration

Config file: `_AiDevLog/.config/daemon.json`

Available settings:
```json
{
  "agentPoolSize": 10,              // 1-20
  "enableUnityFeatures": true,       // boolean
  "stateUpdateInterval": 5000,       // ms (minimum 1000)
  "port": 19840,                     // 1024-65535
  "logLevel": "info"                 // debug|info|warn|error
}
```

### Hot Reload

Config changes apply **immediately** without daemon restart (except `port`).

## Migration

### Automatic Migration

On first load after update, APC automatically migrates:
- `.cache/apc_config.json` → `.config/daemon.json`
- `Config/Roles/` → `.config/roles/`
- `Config/SystemPrompts/` → `.config/system_prompts/`
- `Config/workflow_settings.json` → `.config/workflows.json`
- `Config/context_presets.json` → `.config/context_presets.json`

**Old files are preserved** for safety.

### Working Directory Changes

When you change `workingDirectory` in VS Code settings:
1. Daemon stops gracefully
2. `.config/` and `.cache/` are copied to new location
3. Daemon restarts with new path
4. All settings preserved

## Environment Variables

Override config via environment variables:

```bash
# Pool size
export APC_POOL_SIZE=15

# Unity features
export APC_ENABLE_UNITY=false

# Port
export APC_PORT=19841

# Log level
export APC_LOG_LEVEL=debug

# Working directory
export APC_WORKING_DIR=_AiDevLog
```

## Benefits

1. ✅ **Single Source of Truth**: Daemon config is authoritative
2. ✅ **CLI + GUI Access**: Manage settings from anywhere
3. ✅ **Hot Reload**: Changes apply immediately
4. ✅ **Customizable Folders**: Organize your working directory
5. ✅ **Portable**: Move working dir, config follows
6. ✅ **Clean Architecture**: Extension is pure UI client

## Troubleshooting

### Settings Not Updating

1. Check daemon is running: `apc daemon status`
2. Verify connection: Check VS Code status bar
3. Check config file: `cat _AiDevLog/.config/daemon.json`

### Migration Issues

If config didn't migrate automatically:
1. Check old location: `_AiDevLog/.cache/apc_config.json`
2. Manually copy to: `_AiDevLog/.config/daemon.json`
3. Restart daemon: `apc system restart`

### Reset Everything

```bash
# Reset daemon config
apc config reset

# Reset folders
apc config folders reset

# Or delete config file and restart
rm _AiDevLog/.config/daemon.json
rm _AiDevLog/.config/folders.json
apc system restart
```

## API Reference

For programmatic access, see `src/client/Protocol.ts`:
- `config.get` - Get daemon config
- `config.set` - Update config
- `config.reset` - Reset to defaults
- `folders.get` - Get folder structure
- `folders.set` - Set folder name
- `folders.reset` - Reset folders

## Related Files

- `src/daemon/DaemonConfig.ts` - Config loader
- `src/services/FolderStructureManager.ts` - Folder management
- `src/daemon/ApiHandler.ts` - Config API endpoints
- `src/ui/DaemonSettingsPanel.ts` - GUI panel
- `scripts/apc` - CLI commands

