import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TypedEventEmitter } from './TypedEventEmitter';

const execAsync = promisify(exec);

// ============================================================================
// Dependency Check Types
// ============================================================================

export interface DependencyStatus {
    name: string;
    installed: boolean;
    version?: string;
    required: boolean;
    installUrl?: string;
    installCommand?: string;
    description: string;
    platform: 'darwin' | 'win32' | 'linux' | 'all';
}

/**
 * Result of workspace setup checks
 */
export interface WorkspaceSetupResult {
    passed: boolean;
    checks: WorkspaceCheck[];
}

export interface WorkspaceCheck {
    name: string;
    passed: boolean;
    message: string;
    created?: boolean;  // If we created something that was missing
}

/**
 * DependencyService - Checks system dependencies for APC
 * 
 * Obtain via ServiceLocator:
 *   const deps = ServiceLocator.resolve(DependencyService);
 */
export class DependencyService {
    private cachedStatus: DependencyStatus[] = [];
    private _onStatusChanged = new TypedEventEmitter<void>();
    readonly onStatusChanged = this._onStatusChanged.event;
    private workspaceRoot: string = '';
    
    /** Whether Unity features are enabled (affects which dependencies are checked) */
    private unityEnabled: boolean = true;
    
    /** Periodic check timer */
    private periodicCheckTimer: NodeJS.Timeout | null = null;
    private lastCheckTime: number = 0;
    
    // Optional VS Code integration (set by VS Code client)
    private vscodeIntegration: {
        openExternal?: (url: string) => Promise<void>;
        copyToClipboard?: (text: string) => Promise<void>;
        showMessage?: (message: string) => void;
        getWorkspaceFolders?: () => string[];
        getCommands?: () => Promise<string[]>;
    } = {};

    constructor() {}

    /**
     * Set the workspace root for workspace-level checks
     */
    setWorkspaceRoot(root: string): void {
        this.workspaceRoot = root;
    }
    
    /**
     * Set whether Unity features are enabled
     * When disabled, Unity MCP and temp scene checks are skipped
     */
    setUnityEnabled(enabled: boolean): void {
        this.unityEnabled = enabled;
    }
    
    /**
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this.unityEnabled;
    }
    
    /**
     * Set VS Code integration callbacks (called by VS Code extension)
     */
    setVsCodeIntegration(integration: {
        openExternal?: (url: string) => Promise<void>;
        copyToClipboard?: (text: string) => Promise<void>;
        showMessage?: (message: string) => void;
        getWorkspaceFolders?: () => string[];
        getCommands?: () => Promise<string[]>;
    }): void {
        this.vscodeIntegration = integration;
    }

    async checkAllDependencies(): Promise<DependencyStatus[]> {
        const platform = process.platform as 'darwin' | 'win32' | 'linux';
        const dependencies: DependencyStatus[] = [];

        // Platform-specific dependencies
        if (platform === 'darwin') {
            dependencies.push(await this.checkAppleScript());
            dependencies.push(await this.checkAccessibilityPermission());
        } else if (platform === 'win32') {
            dependencies.push(await this.checkPowerShell());
        } else if (platform === 'linux') {
            dependencies.push(await this.checkXdotool());
        }

        // Common dependencies
        dependencies.push(await this.checkPython());
        dependencies.push(await this.checkCursorCli());
        dependencies.push(await this.checkApcCli());
        
        // Unity-specific dependencies (workspace-level) - only check when Unity features are enabled
        if (this.unityEnabled) {
            dependencies.push(await this.checkUnityMcp());
            dependencies.push(await this.checkUnityTempScene());
        }

        this.cachedStatus = dependencies;
        this.lastCheckTime = Date.now();
        this._onStatusChanged.fire();
        return dependencies;
    }
    
    /**
     * Check if Unity MCP is available and responding
     */
    private async checkUnityMcp(): Promise<DependencyStatus> {
        try {
            // Check MCP config locations (global Cursor config + workspace configs)
            const mcpConfigPaths = [
                // Global Cursor MCP config (most common location)
                path.join(os.homedir(), '.cursor', 'mcp.json'),
                // Workspace-specific configs
                ...(this.workspaceRoot ? [
                    path.join(this.workspaceRoot, '.cursor', 'mcp.json'),
                    path.join(this.workspaceRoot, 'mcp.json')
                ] : [])
            ];
            
            let mcpConfigExists = false;
            let hasUnityMcp = false;
            let configLocation = '';
            
            for (const configPath of mcpConfigPaths) {
                if (fs.existsSync(configPath)) {
                    mcpConfigExists = true;
                    try {
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        // Check if unityMCP is configured (Cursor uses mcpServers key)
                        if (config.mcpServers?.unityMCP || config.servers?.unityMCP) {
                            hasUnityMcp = true;
                            configLocation = configPath;
                            break;
                        }
                    } catch (e) {
                        // JSON parse error, config exists but invalid
                    }
                }
            }
            
            if (hasUnityMcp) {
                return {
                    name: 'Unity MCP',
                    installed: true,
                    required: true,
                    description: 'Unity MCP server configured',
                    platform: 'all'
                };
            } else if (mcpConfigExists) {
                return {
                    name: 'Unity MCP',
                    installed: false,
                    required: true,
                    description: 'MCP config exists but Unity MCP not configured',
                    platform: 'all',
                    installUrl: 'https://github.com/anthropics/anthropic-cookbook/tree/main/misc/mcp'
                };
            } else {
                return {
                    name: 'Unity MCP',
                    installed: false,
                    required: true,
                    description: 'MCP config not found - install Unity MCP via Cursor Settings',
                    platform: 'all',
                    installUrl: 'https://github.com/anthropics/anthropic-cookbook/tree/main/misc/mcp'
                };
            }
        } catch (error) {
            return {
                name: 'Unity MCP',
                installed: false,
                required: true,
                description: `Error checking Unity MCP: ${error}`,
                platform: 'all'
            };
        }
    }
    
    /**
     * Check if Unity temp scene exists for prep_editor
     */
    private async checkUnityTempScene(): Promise<DependencyStatus> {
        if (!this.workspaceRoot) {
            return {
                name: 'Unity Temp Scene',
                installed: false,
                required: false, // Not strictly required, can be created
                description: 'Workspace not set',
                platform: 'all'
            };
        }
        
        const tempScenePath = path.join(this.workspaceRoot, 'Assets/Scenes/_TempCompileCheck.unity');
        const scenesDir = path.join(this.workspaceRoot, 'Assets/Scenes');
        
        if (fs.existsSync(tempScenePath)) {
            return {
                name: 'Unity Temp Scene',
                installed: true,
                required: false,
                description: '_TempCompileCheck.unity ready for prep_editor',
                platform: 'all'
            };
        } else if (fs.existsSync(scenesDir)) {
            return {
                name: 'Unity Temp Scene',
                installed: false,
                required: false,
                description: 'Will be created when Unity Control Agent runs',
                platform: 'all'
            };
        } else {
            return {
                name: 'Unity Temp Scene',
                installed: false,
                required: false,
                description: 'Assets/Scenes folder not found - is this a Unity project?',
                platform: 'all'
            };
        }
    }

    private async checkApcCli(): Promise<DependencyStatus> {
        try {
            await execAsync('which apc || where apc 2>nul');
            return {
                name: 'APC CLI (apc)',
                installed: true,
                required: true,
                description: 'apc command-line tool for AI agents',
                platform: 'all'
            };
        } catch {
            return {
                name: 'APC CLI (apc)',
                installed: false,
                required: true,
                description: 'Click to install → creates apc command in ~/.local/bin',
                platform: 'all'
            };
        }
    }

    async installApcCli(extensionPath: string): Promise<{ success: boolean; message: string }> {
        const platform = process.platform;
        const sourcePath = path.join(extensionPath, 'scripts', 'apc');
        
        // Determine target directory
        let targetDir: string;
        let targetPath: string;
        
        if (platform === 'win32') {
            // Windows: Use AppData\Local\Microsoft\WindowsApps or create ~/bin
            targetDir = path.join(os.homedir(), 'bin');
            targetPath = path.join(targetDir, 'apc.cmd');
        } else {
            // macOS/Linux: Use ~/.local/bin (standard user bin location)
            targetDir = path.join(os.homedir(), '.local', 'bin');
            targetPath = path.join(targetDir, 'apc');
        }

        try {
            // Ensure target directory exists
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            if (platform === 'win32') {
                // Windows: Create a .cmd wrapper
                const cmdContent = `@echo off\nbash "${sourcePath}" %*`;
                fs.writeFileSync(targetPath, cmdContent);
            } else {
                // Unix: Create a symlink
                // Use lstat to detect broken symlinks (existsSync returns false for broken symlinks)
                try {
                    fs.lstatSync(targetPath);
                    // File or symlink exists - remove it
                    fs.unlinkSync(targetPath);
                } catch {
                    // Path doesn't exist - that's fine
                }
                fs.symlinkSync(sourcePath, targetPath);
                // Make sure source is executable
                fs.chmodSync(sourcePath, '755');
            }

            // Check if targetDir is in PATH
            const pathEnv = process.env.PATH || '';
            const inPath = pathEnv.split(path.delimiter).includes(targetDir);

            if (!inPath) {
                const shellConfig = platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
                return {
                    success: true,
                    message: `APC CLI installed to ${targetPath}.\n\nAdd to PATH by running:\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ${shellConfig}\n\nThen restart your terminal or run: source ${shellConfig}`
                };
            }

            return {
                success: true,
                message: `APC CLI installed successfully to ${targetPath}`
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to install APC CLI: ${error}`
            };
        }
    }

    async uninstallApcCli(): Promise<{ success: boolean; message: string }> {
        const platform = process.platform;
        let targetPath: string;

        if (platform === 'win32') {
            targetPath = path.join(os.homedir(), 'bin', 'apc.cmd');
        } else {
            targetPath = path.join(os.homedir(), '.local', 'bin', 'apc');
        }

        try {
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
                return { success: true, message: `APC CLI removed from ${targetPath}` };
            }
            return { success: true, message: 'APC CLI was not installed' };
        } catch (error) {
            return { success: false, message: `Failed to uninstall: ${error}` };
        }
    }

    getCachedStatus(): DependencyStatus[] {
        return this.cachedStatus;
    }

    areAllRequiredMet(): boolean {
        const platform = process.platform;
        return this.cachedStatus
            .filter(d => d.required && (d.platform === platform || d.platform === 'all'))
            .every(d => d.installed);
    }

    private async checkAppleScript(): Promise<DependencyStatus> {
        try {
            await execAsync('osascript -e "return 1"');
            return {
                name: 'AppleScript',
                installed: true,
                required: true,
                description: 'macOS automation (built-in)',
                platform: 'darwin'
            };
        } catch {
            return {
                name: 'AppleScript',
                installed: false,
                required: true,
                description: 'macOS automation - should be built-in',
                platform: 'darwin'
            };
        }
    }

    private async checkAccessibilityPermission(): Promise<DependencyStatus> {
        // Test if we can send keystrokes via System Events
        try {
            // This will fail if accessibility permission is not granted
            await execAsync('osascript -e \'tell application "System Events" to return name of first process\'');
            return {
                name: 'Accessibility Permission',
                installed: true,
                required: true,
                description: 'Required for keyboard automation',
                platform: 'darwin',
                installUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            };
        } catch {
            return {
                name: 'Accessibility Permission',
                installed: false,
                required: true,
                description: 'Grant Cursor accessibility permission in System Settings',
                platform: 'darwin',
                installUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            };
        }
    }

    private async checkPowerShell(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('powershell -Command "$PSVersionTable.PSVersion.ToString()"');
            return {
                name: 'PowerShell',
                installed: true,
                version: stdout.trim(),
                required: true,
                description: 'Windows automation (built-in)',
                platform: 'win32'
            };
        } catch {
            return {
                name: 'PowerShell',
                installed: false,
                required: true,
                description: 'Windows PowerShell - should be built-in',
                platform: 'win32',
                installUrl: 'https://docs.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows'
            };
        }
    }

    private async checkXdotool(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('xdotool --version');
            const version = stdout.split('\n')[0]?.replace('xdotool version ', '').trim();
            return {
                name: 'xdotool',
                installed: true,
                version,
                required: true,
                description: 'Linux keyboard automation',
                platform: 'linux'
            };
        } catch {
            return {
                name: 'xdotool',
                installed: false,
                required: true,
                description: 'Required for keyboard automation on Linux',
                platform: 'linux',
                installCommand: 'sudo apt install xdotool',
                installUrl: 'https://github.com/jordansissel/xdotool'
            };
        }
    }

    private async checkPython(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('python3 --version');
            const version = stdout.trim().replace('Python ', '');
            return {
                name: 'Python 3',
                installed: true,
                version,
                required: true,
                description: 'Required for coordinator script',
                platform: 'all',
                installUrl: 'https://www.python.org/downloads/'
            };
        } catch {
            try {
                // Try 'python' command on Windows
                const { stdout } = await execAsync('python --version');
                if (stdout.includes('Python 3')) {
                    return {
                        name: 'Python 3',
                        installed: true,
                        version: stdout.trim().replace('Python ', ''),
                        required: true,
                        description: 'Required for coordinator script',
                        platform: 'all'
                    };
                }
            } catch {}
            return {
                name: 'Python 3',
                installed: false,
                required: true,
                description: 'Required for coordinator script',
                platform: 'all',
                installUrl: 'https://www.python.org/downloads/'
            };
        }
    }

    private async checkCursorCli(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('cursor --version');
            return {
                name: 'Cursor CLI',
                installed: true,
                version: stdout.trim(),
                required: true,
                description: 'Required for launching engineer sessions',
                platform: 'all',
                installUrl: 'cursor://settings/cli'
            };
        } catch {
            return {
                name: 'Cursor CLI',
                installed: false,
                required: true,
                description: 'Install from Cursor: Cmd/Ctrl+Shift+P → "Install cursor command"',
                platform: 'all',
                installUrl: 'cursor://settings/cli'
            };
        }
    }

    async openInstallUrl(dep: DependencyStatus): Promise<void> {
        if (dep.installUrl && this.vscodeIntegration.openExternal) {
            await this.vscodeIntegration.openExternal(dep.installUrl);
        } else if (dep.installUrl) {
            console.log(`Open URL to install: ${dep.installUrl}`);
        }
    }

    async copyInstallCommand(dep: DependencyStatus): Promise<void> {
        if (dep.installCommand) {
            if (this.vscodeIntegration.copyToClipboard) {
                await this.vscodeIntegration.copyToClipboard(dep.installCommand);
                if (this.vscodeIntegration.showMessage) {
                    this.vscodeIntegration.showMessage(`Install command copied: ${dep.installCommand}`);
                }
            } else {
                console.log(`Install command: ${dep.installCommand}`);
            }
        }
    }
    
    // ========================================================================
    // Periodic Check Methods
    // ========================================================================
    
    /**
     * Start periodic dependency checking
     * @param intervalMs Interval in milliseconds between checks (default: 30000)
     */
    startPeriodicCheck(intervalMs: number = 30000): void {
        // Stop any existing timer
        this.stopPeriodicCheck();
        
        console.log(`[DependencyService] Starting periodic check every ${intervalMs / 1000}s`);
        
        this.periodicCheckTimer = setInterval(async () => {
            try {
                const previousStatus = [...this.cachedStatus];
                await this.checkAllDependencies();
                
                // Check if status changed
                const statusChanged = this.hasStatusChanged(previousStatus, this.cachedStatus);
                if (statusChanged) {
                    console.log('[DependencyService] Dependency status changed');
                    this._onStatusChanged.fire();
                }
            } catch (e) {
                console.warn('[DependencyService] Periodic check failed:', e);
            }
        }, intervalMs);
    }
    
    /**
     * Stop periodic dependency checking
     */
    stopPeriodicCheck(): void {
        if (this.periodicCheckTimer) {
            clearInterval(this.periodicCheckTimer);
            this.periodicCheckTimer = null;
            console.log('[DependencyService] Stopped periodic check');
        }
    }
    
    /**
     * Check if dependency status has changed
     */
    private hasStatusChanged(previous: DependencyStatus[], current: DependencyStatus[]): boolean {
        if (previous.length !== current.length) return true;
        
        for (const curr of current) {
            const prev = previous.find(p => p.name === curr.name);
            if (!prev) return true;
            if (prev.installed !== curr.installed) return true;
            if (prev.version !== curr.version) return true;
        }
        
        return false;
    }
    
    /**
     * Get the time of the last dependency check
     */
    getLastCheckTime(): number {
        return this.lastCheckTime;
    }
    
    /**
     * Dispose resources
     */
    dispose(): void {
        this.stopPeriodicCheck();
        this._onStatusChanged.dispose();
    }

    // ========================================================================
    // Workspace Setup Checks (Run after workspace is opened)
    // ========================================================================

    /**
     * Check and setup workspace-level requirements
     * Call this after workspace is opened and Unity MCP is available
     */
    async checkWorkspaceSetup(): Promise<WorkspaceSetupResult> {
        if (!this.workspaceRoot) {
            return {
                passed: false,
                checks: [{
                    name: 'Workspace Root',
                    passed: false,
                    message: 'Workspace root not set'
                }]
            };
        }

        const checks: WorkspaceCheck[] = [];

        // Check/create working directories
        checks.push(await this.checkWorkingDirectories());

        // Check/create error registry
        checks.push(await this.checkErrorRegistry());

        // Check/create temp scene (requires Unity MCP - may fail if Unity not running)
        checks.push(await this.checkTempScene());

        return {
            passed: checks.every(c => c.passed),
            checks
        };
    }

    /**
     * Ensure all working directories exist
     */
    private async checkWorkingDirectories(): Promise<WorkspaceCheck> {
        const directories = [
            '_AiDevLog',
            '_AiDevLog/Plans',
            '_AiDevLog/Tasks',             // Global tasks storage
            '_AiDevLog/Logs',
            '_AiDevLog/Logs/Coordinator',  // Global coordinator evaluation logs
            '_AiDevLog/Context',
            '_AiDevLog/Errors',
            '_AiDevLog/Docs',
            '_AiDevLog/Scripts',
            '_AiDevLog/Notifications'
        ];

        const created: string[] = [];

        try {
            for (const dir of directories) {
                const fullPath = path.join(this.workspaceRoot, dir);
                if (!fs.existsSync(fullPath)) {
                    fs.mkdirSync(fullPath, { recursive: true });
                    created.push(dir);
                }
            }

            if (created.length > 0) {
                return {
                    name: 'Working Directories',
                    passed: true,
                    message: `Created: ${created.join(', ')}`,
                    created: true
                };
            }

            return {
                name: 'Working Directories',
                passed: true,
                message: 'All directories exist'
            };
        } catch (error) {
            return {
                name: 'Working Directories',
                passed: false,
                message: `Failed to create directories: ${error}`
            };
        }
    }

    /**
     * Ensure error registry file exists
     */
    private async checkErrorRegistry(): Promise<WorkspaceCheck> {
        const registryPath = path.join(this.workspaceRoot, '_AiDevLog/Errors/error_registry.md');

        try {
            if (!fs.existsSync(registryPath)) {
                const template = this.getErrorRegistryTemplate();
                fs.writeFileSync(registryPath, template, 'utf-8');

                return {
                    name: 'Error Registry',
                    passed: true,
                    message: 'Created error_registry.md',
                    created: true
                };
            }

            return {
                name: 'Error Registry',
                passed: true,
                message: 'error_registry.md exists'
            };
        } catch (error) {
            return {
                name: 'Error Registry',
                passed: false,
                message: `Failed to create error registry: ${error}`
            };
        }
    }

    /**
     * Check/create temp scene for Unity compilation checks
     * This requires Unity MCP to be available
     */
    private async checkTempScene(): Promise<WorkspaceCheck> {
        const tempScenePath = 'Assets/Scenes/_TempCompileCheck.unity';
        const fullPath = path.join(this.workspaceRoot, tempScenePath);

        // First check if file exists on disk
        if (fs.existsSync(fullPath)) {
            return {
                name: 'Temp Compile Scene',
                passed: true,
                message: '_TempCompileCheck scene exists'
            };
        }

        // Scene doesn't exist - we'll need to create it via MCP
        // But we can't do that here directly - mark as needing creation
        // The UnityControlManager will create it when it initializes

        return {
            name: 'Temp Compile Scene',
            passed: true,  // Pass for now, UnityControlManager will handle creation
            message: 'Scene will be created by Unity Control Agent when Unity is available'
        };
    }

    /**
     * Create temp scene via Unity MCP
     * Call this from UnityControlManager when Unity is available
     */
    async createTempSceneViaMcp(): Promise<{ success: boolean; message: string }> {
        // This method is called by UnityControlManager
        // It should use MCP to create the scene
        // For now, return a placeholder - actual implementation in UnityControlManager
        return {
            success: false,
            message: 'Use UnityControlManager.ensureTempSceneExists() instead'
        };
    }

    /**
     * Get the error registry template
     */
    private getErrorRegistryTemplate(): string {
        return `# Active Error Registry

> **IMPORTANT**: Before fixing any error, check this document!
> If an error is already assigned, DO NOT work on it.
> After fixing, mark it as FIXED with your name.

Last Updated: ${new Date().toISOString()}

---

## 🔴 Compilation Errors

(No active compilation errors)

---

## 🟡 Runtime Errors

(No active runtime errors)

---

## 🟣 Test Failures

(No active test failures)

---

## Status Legend
- ⏳ PENDING - Not yet assigned
- 🔧 FIXING - Engineer is working on it
- ✅ FIXED - Fixed, awaiting verification
- ✔️ VERIFIED - Confirmed fixed after recompile/test
- ❌ WONTFIX - Not going to fix (with reason)

---

## Rules for Engineers

1. **Before starting any error fix**:
   - Read this document
   - If error is FIXING by someone else, DO NOT touch it
   - If error is PENDING and assigned to you, claim it by updating status to FIXING

2. **When you start fixing**:
   - Update status to 🔧 FIXING
   - Add your name and timestamp

3. **When you finish fixing**:
   - Update status to ✅ FIXED
   - Add brief fix summary
   - Request compilation to verify

4. **If you can't fix**:
   - Update notes with what you tried
   - Set status back to ⏳ PENDING for reassignment
`;
    }

    /**
     * Get the path to the error registry
     */
    getErrorRegistryPath(): string {
        return path.join(this.workspaceRoot, '_AiDevLog/Errors/error_registry.md');
    }

    /**
     * Get the path to the temp scene
     */
    getTempScenePath(): string {
        return 'Assets/Scenes/_TempCompileCheck.unity';
    }
}

