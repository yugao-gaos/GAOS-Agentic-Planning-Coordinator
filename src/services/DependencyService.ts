import { exec, execSync, spawnSync, ExecOptions } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TypedEventEmitter } from './TypedEventEmitter';
import { ServiceLocator } from './ServiceLocator';
import { AgentRunner } from './AgentBackend';
import { CursorAgentRunner } from './CursorAgentRunner';
import { Logger } from '../utils/Logger';

const execAsyncRaw = promisify(exec);
const log = Logger.create('Daemon', 'DependencyService');

/**
 * Wrapper for exec that automatically hides terminal windows on Windows.
 * This prevents empty CMD windows from flashing during dependency checks.
 */
const execAsync = (command: string, options?: ExecOptions): Promise<{ stdout: string; stderr: string }> => {
    return execAsyncRaw(command, { 
        encoding: 'utf8',  // Ensure string output
        ...options, 
        windowsHide: true 
    }) as Promise<{ stdout: string; stderr: string }>;
};

// ============================================================================
// Unity MCP Config Types
// ============================================================================

interface UnityMcpConfigResult {
    mcpConfigExists: boolean;
    hasUnityMcp: boolean;
    mcpUrl: string | null;
    configPath: string | null;
}

/** Result of Unity MCP connectivity test */
interface UnityMcpConnectivityResult {
    connected: boolean;
    error?: string;
    requiresLogin?: boolean;
}

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
    /** Special handling type - e.g. 'cursor-agent-cli' for login vs install, 'retry' for re-check */
    installType?: 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli' | 'unity-mcp' | 'retry';
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
    private cacheTimestamp: number = 0;
    private useCacheForNextCheck: boolean = false;  // Flag for post-install check
    private _onStatusChanged = new TypedEventEmitter<void>();
    readonly onStatusChanged = this._onStatusChanged.event;
    private workspaceRoot: string = '';
    
    /** Whether Unity features are enabled (affects which dependencies are checked) */
    private unityEnabled: boolean = true;
    
    /** Whether this workspace is a Unity project (auto-detected) */
    private isUnityProjectCached: boolean | null = null;
    
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
    
    /** Progress callback for real-time dependency check updates */
    private progressCallback?: (name: string, status: DependencyStatus) => void;

    constructor() {}
    
    /**
     * Refresh the process environment to ensure newly installed CLIs are findable.
     * 
     * This does two things:
     * 1. Adds expected bin directories to process.env.PATH (so new CLIs can be found)
     * 2. Clears cached CLI paths in workflows (so they re-resolve on next use)
     * 
     * Call this after installation or when refreshing dependencies.
     */
    refreshEnvironment(): void {
        const platform = process.platform;
        const pathSeparator = platform === 'win32' ? ';' : ':';
        const currentPath = process.env.PATH || '';
        
        // Determine expected bin directories
        const expectedDirs: string[] = [];
        if (platform === 'win32') {
            // Windows: ~/bin (where apc.cmd is installed)
            expectedDirs.push(path.join(os.homedir(), 'bin'));
        } else {
            // Unix: ~/.local/bin (standard user bin location)
            expectedDirs.push(path.join(os.homedir(), '.local', 'bin'));
            // Also /usr/local/bin in case of system-wide install
            expectedDirs.push('/usr/local/bin');
        }
        
        // Add missing directories to PATH
        const currentDirs = currentPath.split(pathSeparator).map(d => d.toLowerCase());
        const dirsToAdd: string[] = [];
        
        for (const dir of expectedDirs) {
            if (fs.existsSync(dir) && !currentDirs.includes(dir.toLowerCase())) {
                dirsToAdd.push(dir);
            }
        }
        
        if (dirsToAdd.length > 0) {
            process.env.PATH = [...dirsToAdd, currentPath].join(pathSeparator);
            log.info(`Updated process.env.PATH with: ${dirsToAdd.join(', ')}`);
        }
        
        // Clear cached CLI paths in BaseWorkflow
        // Import dynamically to avoid circular dependency
        try {
            const { BaseWorkflow } = require('./workflows/BaseWorkflow');
            BaseWorkflow.clearApcPathCache();
            log.debug('Cleared BaseWorkflow apc path cache');
        } catch (e) {
            // BaseWorkflow not available in some contexts (e.g., client-side)
            log.debug('Could not clear BaseWorkflow cache (may be client-side context)');
        }
    }
    
    /**
     * Get the list of all dependencies that will be checked (without checking them).
     * Returns dependency names only, useful for showing UI progress before checks start.
     */
    getDependencyList(): string[] {
        const platform = process.platform;
        const dependencies: string[] = [];
        
        // Platform-specific dependencies
        if (platform === 'darwin') {
            dependencies.push('AppleScript', 'Accessibility Permission');
        } else if (platform === 'win32') {
            dependencies.push('PowerShell');
        } else if (platform === 'linux') {
            dependencies.push('xdotool');
        }
        
        // Common dependencies (checked on all platforms)
        dependencies.push(
            'Cursor CLI',
            'Cursor Agent CLI',
            'APC CLI (apc)'
        );
        
        // WSL-specific (only on Windows)
        if (platform === 'win32') {
            dependencies.push(
                'Node.js in WSL',
                'apc CLI in WSL'
            );
        }
        
        // Unity dependencies (if enabled)
        if (this.unityEnabled && this.isUnityProject()) {
            dependencies.push('MCP for Unity', 'Unity Temp Scene');
        }
        
        return dependencies;
    }

    /**
     * Set the workspace root for workspace-level checks
     */
    setWorkspaceRoot(root: string): void {
        if (this.workspaceRoot !== root) {
            this.workspaceRoot = root;
            // Clear Unity project cache when workspace changes
            this.clearUnityProjectCache();
        }
    }
    
    /**
     * Set whether Unity features are enabled
     * When disabled, Unity MCP and temp scene checks are skipped
     */
    setUnityEnabled(enabled: boolean): void {
        this.unityEnabled = enabled;
    }
    
    /**
     * Set progress callback for real-time dependency check updates
     * Called after each individual dependency is checked
     */
    setProgressCallback(callback: (name: string, status: DependencyStatus) => void): void {
        this.progressCallback = callback;
    }
    
    /**
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this.unityEnabled;
    }
    
    /**
     * Detect if the current workspace is a Unity project
     * Checks for: Assets/ folder, ProjectSettings/ folder, or *.unity files
     */
    isUnityProject(): boolean {
        // Return cached value if available
        if (this.isUnityProjectCached !== null) {
            return this.isUnityProjectCached;
        }
        
        if (!this.workspaceRoot) {
            return false;
        }
        
        // Check for Unity project markers
        const unityMarkers = [
            path.join(this.workspaceRoot, 'Assets'),
            path.join(this.workspaceRoot, 'ProjectSettings'),
            path.join(this.workspaceRoot, 'ProjectSettings', 'ProjectSettings.asset'),
        ];
        
        for (const marker of unityMarkers) {
            if (fs.existsSync(marker)) {
                this.isUnityProjectCached = true;
                return true;
            }
        }
        
        this.isUnityProjectCached = false;
        return false;
    }
    
    /**
     * Clear the Unity project detection cache (call when workspace changes)
     */
    clearUnityProjectCache(): void {
        this.isUnityProjectCached = null;
    }
    
    // ========================================================================
    // Unity MCP Helper Methods
    // ========================================================================
    
    /**
     * Find Unity MCP configuration and extract the URL
     * Checks global Cursor config and workspace-specific configs
     */
    private findUnityMcpConfig(): UnityMcpConfigResult {
        const result: UnityMcpConfigResult = {
            mcpConfigExists: false,
            hasUnityMcp: false,
            mcpUrl: null,
            configPath: null
        };
        
        let mcpConfigPaths: string[];
        
        if (process.platform === 'win32') {
            // On Windows, cursor-agent runs in WSL, so check WSL home directory
            try {
                const { execSync } = require('child_process');
                const wslUsername = execSync('wsl -d Ubuntu bash -c "whoami"', { encoding: 'utf8', windowsHide: true }).trim();
                mcpConfigPaths = [
                    // WSL home directory (where cursor-agent actually runs)
                    `\\\\wsl$\\Ubuntu\\home\\${wslUsername}\\.cursor\\mcp.json`,
                    // Workspace-specific configs
                    ...(this.workspaceRoot ? [
                        path.join(this.workspaceRoot, '.cursor', 'mcp.json'),
                        path.join(this.workspaceRoot, 'mcp.json')
                    ] : [])
                ];
            } catch (wslError) {
                // Cannot get WSL username - fail explicitly
                const errorMsg = wslError instanceof Error ? wslError.message : String(wslError);
                log.error(`Failed to detect WSL username: ${errorMsg}`);
                throw new Error(
                    `Cannot detect WSL username for Unity MCP config path detection. ` +
                    `Please ensure WSL is properly configured. Error: ${errorMsg}`
                );
            }
        } else {
            // macOS/Linux: native paths
            mcpConfigPaths = [
                // Global Cursor MCP config (most common location)
                path.join(os.homedir(), '.cursor', 'mcp.json'),
                // Workspace-specific configs
                ...(this.workspaceRoot ? [
                    path.join(this.workspaceRoot, '.cursor', 'mcp.json'),
                    path.join(this.workspaceRoot, 'mcp.json')
                ] : [])
            ];
        }
        
        for (const configPath of mcpConfigPaths) {
            if (fs.existsSync(configPath)) {
                result.mcpConfigExists = true;
                try {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    // Check for unity-mcp in various config structures
                    // IMPORTANT: Must match the server name used in installMCP() calls!
                    const unityConfig = 
                        config.mcpServers?.['unity-mcp'] ||  // Correct name with hyphen!
                        config.servers?.['unity-mcp'] ||
                        // Legacy names for backwards compatibility (but we don't use these anymore)
                        config.mcpServers?.UnityMCP || 
                        config.mcpServers?.unityMCP ||
                        config.servers?.UnityMCP || 
                        config.servers?.unityMCP ||
                        config.UnityMCP ||
                        config.unityMCP;
                    
                    if (unityConfig) {
                        result.hasUnityMcp = true;
                        result.configPath = configPath;
                        // Extract URL - CoplayDev uses HTTP transport with "url" field
                        result.mcpUrl = unityConfig.url || null;
                        break;
                    }
                } catch {
                    // JSON parse error, config exists but invalid
                }
            }
        }
        
        return result;
    }
    
    /**
     * Get the Unity MCP URL for cursor-agent to connect to
     * 
     * REQUIREMENTS:
     * - On Windows: WSL mirrored mode MUST be enabled (set up by install script)
     * - This allows cursor-agent (in WSL) to connect to Unity MCP (on Windows) via localhost
     * 
     * No fallbacks - if mirrored mode is not enabled, dependency check will FAIL with clear error.
     */
    private getUnityMcpUrl(): string {
        const DEFAULT_PORT = '8080';  // Unity MCP default port
        
        // Always use localhost - mirrored mode is REQUIRED on Windows
        // IMPORTANT: Unity MCP server expects requests at /mcp endpoint, not root!
        return `http://localhost:${DEFAULT_PORT}/mcp`;
    }
    
    /**
     * Check if WSL mirrored networking mode is enabled (Windows only)
     * 
     * Mirrored mode is REQUIRED for cursor-agent (in WSL) to access Unity MCP (on Windows) via localhost
     * 
     * Returns: { enabled: true } if mirrored mode is enabled
     *          { enabled: false, error: string } if not enabled or can't determine
     */
    private checkWslMirroredMode(): { enabled: boolean; error?: string } {
        if (process.platform !== 'win32') {
            return { enabled: true };  // Not Windows, no check needed
        }
        
        try {
            const homePath = process.env.USERPROFILE || process.env.HOME;
            if (!homePath) {
                return { enabled: false, error: 'Could not determine user home directory' };
            }
            
            const wslConfigPath = path.join(homePath, '.wslconfig');
            
            if (!fs.existsSync(wslConfigPath)) {
                return { 
                    enabled: false, 
                    error: '.wslconfig not found. WSL mirrored mode is not configured.\n' +
                           'Mirrored mode allows cursor-agent (in WSL) to connect to Unity MCP (on Windows) via localhost.'
                };
            }
            
            const wslConfig = fs.readFileSync(wslConfigPath, 'utf8');
            
            if (!wslConfig.match(/networkingMode\s*=\s*mirrored/i)) {
                return { 
                    enabled: false, 
                    error: '.wslconfig exists but mirrored mode not enabled.\n' +
                           'Add this to your .wslconfig:\n' +
                           '[wsl2]\n' +
                           'networkingMode=mirrored'
                };
            }
            
            // Mirrored mode is enabled!
            return { enabled: true };
            
        } catch (error) {
            return { 
                enabled: false, 
                error: `Could not check WSL mirrored mode: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    
    /**
     * Auto-sync Unity MCP configuration
     * 
     * Automatically configures Unity MCP with the correct URL for the current network.
     * This ensures:
     * - MCP config exists in the correct location (WSL on Windows)
     * - URL uses correct networking mode (localhost for mirrored, host IP for NAT)
     * - Updates automatically when network/IP changes
     * 
     * Called on daemon startup and during dependency checks.
     */
    async autoSyncUnityMcp(): Promise<void> {
        try {
            // Only auto-sync if this is a Unity project
            if (!this.isUnityProject()) {
                return;
            }
            
            log.debug('Auto-syncing Unity MCP configuration...');
            
            const agentRunner = ServiceLocator.resolve(AgentRunner);
            const currentUrl = this.getUnityMcpUrl();
            
            // Check current MCP config
            const mcpConfig = this.findUnityMcpConfig();
            
            if (!mcpConfig.hasUnityMcp) {
                // MCP not configured at all - install it
                log.info('Unity MCP not configured, auto-installing...');
                const result = await agentRunner.installMCP({
                    name: 'unity-mcp',  // Must match MCP tool prefix: mcp_unity-mcp_*
                    url: currentUrl
                });
                if (result.success) {
                    log.info(`Unity MCP auto-configured: ${currentUrl}`);
                } else {
                    log.warn(`Failed to auto-configure Unity MCP: ${result.message}`);
                }
            } else if (mcpConfig.mcpUrl !== currentUrl) {
                // MCP configured but with wrong URL - update it
                log.info(`Unity MCP URL needs update: ${mcpConfig.mcpUrl} → ${currentUrl}`);
                const result = await agentRunner.installMCP({
                    name: 'unity-mcp',  // Must match MCP tool prefix: mcp_unity-mcp_*
                    url: currentUrl
                });
                if (result.success) {
                    log.info('Unity MCP URL updated automatically');
                } else {
                    log.warn(`Failed to update Unity MCP URL: ${result.message}`);
                }
            } else {
                // MCP already configured correctly
                log.debug(`Unity MCP already configured correctly: ${currentUrl}`);
            }
        } catch (error) {
            log.warn(`Error during Unity MCP auto-sync: ${error}`);
        }
    }
    
    /**
     * Check if Unity MCP package is installed in the Unity project
     * Looks for CoplayDev/unity-mcp in Packages/manifest.json
     */
    private checkUnityMcpPackageInstalled(): { installed: boolean; version?: string } {
        if (!this.workspaceRoot || !this.isUnityProject()) {
            return { installed: false };
        }
        
        const manifestPath = path.join(this.workspaceRoot, 'Packages', 'manifest.json');
        
        if (!fs.existsSync(manifestPath)) {
            return { installed: false };
        }
        
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            const dependencies = manifest.dependencies || {};
            
            // Check for various possible package names from CoplayDev/unity-mcp
            // The package might be installed via git URL or scoped registry
            const possiblePackageNames = [
                'com.coplaydev.unity-mcp',
                'com.coplaydev.unitymcp',
                'com.unity.mcp',
                'unity-mcp'
            ];
            
            for (const packageName of possiblePackageNames) {
                if (dependencies[packageName]) {
                    const version = dependencies[packageName];
                    return { 
                        installed: true, 
                        version: typeof version === 'string' ? version : undefined 
                    };
                }
            }
            
            // Also check if installed via git URL containing "unity-mcp" or "CoplayDev"
            for (const [pkgName, pkgVersion] of Object.entries(dependencies)) {
                const versionStr = String(pkgVersion);
                if (versionStr.includes('unity-mcp') || 
                    versionStr.toLowerCase().includes('coplaydev') ||
                    pkgName.toLowerCase().includes('unitymcp')) {
                    return { installed: true, version: versionStr };
                }
            }
            
            return { installed: false };
        } catch {
            return { installed: false };
        }
    }
    
    /**
     * Install Unity MCP package into the Unity project's Packages/manifest.json
     * Adds the package via Git URL
     * @returns success status and message
     */
    async installUnityMcpPackage(): Promise<{ success: boolean; message: string }> {
        if (!this.workspaceRoot) {
            return { success: false, message: 'Workspace root not set' };
        }
        
        if (!this.isUnityProject()) {
            return { success: false, message: 'Not a Unity project' };
        }
        
        const manifestPath = path.join(this.workspaceRoot, 'Packages', 'manifest.json');
        
        if (!fs.existsSync(manifestPath)) {
            return { success: false, message: 'Packages/manifest.json not found' };
        }
        
        try {
            // Read manifest
            const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent);
            
            if (!manifest.dependencies) {
                manifest.dependencies = {};
            }
            
            // Check if already installed
            const existingCheck = this.checkUnityMcpPackageInstalled();
            if (existingCheck.installed) {
                return { 
                    success: true, 
                    message: `Unity MCP package already installed (${existingCheck.version || 'version unknown'})` 
                };
            }
            
            // Add the package via Git URL
            // Using the GitHub repo URL - Unity will clone and import
            const packageName = 'com.coplaydev.unity-mcp';
            const gitUrl = 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity';
            
            manifest.dependencies[packageName] = gitUrl;
            
            // Write back with preserved formatting
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
            
            log.info(`Added ${packageName} to Packages/manifest.json`);
            
            return {
                success: true,
                message: 'Unity MCP package added to manifest.json. Unity will import it automatically. If Unity is open, it may take a moment to import.'
            };
        } catch (error) {
            log.error('Failed to install Unity MCP package:', error);
            return {
                success: false,
                message: `Failed to install Unity package: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    
    /**
     * Full Unity MCP installation - both MCP config and Unity package
     * This is the comprehensive install that should be used by auto-install and manual install buttons
     * @returns success status, message, and whether restart is required
     */
    async installUnityMcpComplete(): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
        const results: string[] = [];
        let requiresRestart = false;
        
        try {
            log.info('[DependencyService] Starting Unity MCP installation...');
            
            // Step 1: Install MCP configuration in Cursor
            log.info('[DependencyService] Step 1: Installing MCP configuration...');
            const agentRunner = ServiceLocator.resolve(AgentRunner);
            const mcpResult = await agentRunner.installMCP({
                name: 'unity-mcp',  // Must match MCP tool prefix: mcp_unity-mcp_*
                url: this.getUnityMcpUrl()  // Get platform-appropriate URL
            });
            
            log.info('[DependencyService] MCP install result:', mcpResult);
            
            if (mcpResult.success) {
                results.push('✓ MCP config: ' + mcpResult.message);
                if (mcpResult.requiresRestart) {
                    requiresRestart = true;
                }
            } else {
                results.push('✗ MCP config failed: ' + mcpResult.message);
            }
            
            // Step 2: Install Unity package (only for Unity projects)
            log.info('[DependencyService] Step 2: Checking if Unity project...');
            if (this.isUnityProject()) {
                log.info('[DependencyService] Is Unity project, installing package...');
                const packageResult = await this.installUnityMcpPackage();
                log.info('[DependencyService] Package install result:', packageResult);
                
                if (packageResult.success) {
                    results.push('✓ Unity package: ' + packageResult.message);
                } else {
                    results.push('✗ Unity package failed: ' + packageResult.message);
                }
            } else {
                log.info('[DependencyService] Not a Unity project, skipping package install');
                results.push('⊘ Unity package: Skipped (not a Unity project)');
            }
            
            // Determine overall success
            const allSuccess = !results.some(r => r.startsWith('✗'));
            
            log.info('[DependencyService] Installation complete. Results:', results);
            log.info('[DependencyService] All success:', allSuccess);
            
            return {
                success: allSuccess,
                message: results.join('\n') || 'Installation completed but no details available',
                requiresRestart
            };
        } catch (error) {
            log.error('[DependencyService] Installation exception:', error);
            return {
                success: false,
                message: `Unity MCP installation failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    
    /**
     * Smart connectivity check that handles authentication automatically
     * 
     * Flow:
     * 1. Check if cursor-agent is available
     * 2. Check if authenticated
     * 3. If not authenticated:
     *    - If interactive=true: Open login terminal and return instruction
     *    - If interactive=false: Return auth error
     * 4. If authenticated: Run normal connectivity test
     * 
     * @param interactive If true, opens terminal for login when needed
     * @param timeoutMs Timeout for connectivity test (default: 180000 = 3 minutes)
     */
    async testUnityMcpConnectionSmart(interactive: boolean = false, tryCreateTempScene: boolean = false, timeoutMs: number = 180000): Promise<UnityMcpConnectivityResult> {
        try {
            const agentRunner = ServiceLocator.resolve(AgentRunner);
            const backend = agentRunner['backend'] as CursorAgentRunner; // Access private backend (CursorAgentRunner)
            
            if (!backend || typeof backend.isAvailableAndAuthenticated !== 'function') {
                log.warn('Backend does not support authentication check, using basic connectivity test');
                // Backend doesn't support auth check, use basic test
                // This is logged explicitly so users know which method is being used
                return await this.testUnityMcpConnectionViaAgent(tryCreateTempScene, timeoutMs);
            }
            
            // Check availability and authentication
            const status = await backend.isAvailableAndAuthenticated();
            
            if (!status.available) {
                return {
                    connected: false,
                    error: 'cursor-agent not installed. Please install it first.'
                };
            }
            
            if (!status.authenticated) {
                log.debug('cursor-agent not authenticated');
                
                if (interactive) {
                    // Open login terminal
                    const loginResult = await backend.login(true);
                    return {
                        connected: false,
                        error: 'Authentication required. ' + loginResult.message,
                        requiresLogin: true
                    };
                } else {
                    // Return auth error with instruction
                    return {
                        connected: false,
                        error: 'Authentication required. Please run \'cursor-agent login\' first, or set CURSOR_API_KEY environment variable.',
                        requiresLogin: true
                    };
                }
            }
            
            // Authenticated - proceed with normal connectivity test
            log.debug('cursor-agent authenticated, testing connectivity...');
            return await this.testUnityMcpConnectionViaAgent(tryCreateTempScene, timeoutMs);
            
        } catch (error: any) {
            log.error('Smart connectivity check failed:', error);
            return {
                connected: false,
                error: error.message || 'Unknown error'
            };
        }
    }
    
    /**
     * Test Unity MCP connectivity via agent session
     * Runs a quick agent that calls mcp_unity-mcp_manage_editor with GetState
     * Optionally can also create the temp scene if missing
     * 
     * NOTE: This should only be called in daemon context (caller should check ServiceLocator.isRegistered(AgentRunner))
     * 
     * @param tryCreateTempScene If true, also creates _TempCompileCheck.unity scene via MCP if missing
     * @param timeoutMs Timeout in milliseconds (default: 180000 = 3 minutes)
     */
    private async testUnityMcpConnectionViaAgent(tryCreateTempScene: boolean = false, timeoutMs: number = 180000): Promise<UnityMcpConnectivityResult> {
        try {
            const agentRunner = ServiceLocator.resolve(AgentRunner);
            
            // Check if agent backend is available
            const isAvailable = await agentRunner.isAvailable();
            if (!isAvailable) {
                log.debug('Agent backend not available');
                return { 
                    connected: false, 
                    error: 'Agent backend not available' 
                };
            }
            
            log.debug(`Spawning connectivity test agent (timeout: ${timeoutMs / 1000}s)...`);
            
            // Use unique ID to avoid conflicts with previous runs
            // ProcessManager kills previous process if same ID is reused
            const uniqueId = `unity_mcp_connectivity_check_${Date.now()}`;
            
            let outputBuffer = '';
            let stderrBuffer = '';
            
            // Build prompt based on whether we need to create temp scene
            const basePrompt = tryCreateTempScene 
                ? `Test Unity MCP connectivity AND create temp scene.

INSTRUCTIONS:
1. First, call: mcp_unity-mcp_manage_scene with Action="Create", Name="_TempCompileCheck", Path="Assets/Scenes/_TempCompileCheck.unity"
2. Then, call: mcp_unity-mcp_manage_editor with Action="GetState" to verify connection
3. Based on the result, reply with ONLY ONE of these exact formats:
   - If successful: CONNECTED
   - If failed: ERROR: <brief reason>

CRITICAL: Your entire response must be ONLY the word "CONNECTED" or "ERROR: reason". Do not add any explanation, markdown, or other text.`
                : `Test Unity MCP connectivity by calling the MCP tool.

INSTRUCTIONS:
1. Call the MCP tool: mcp_unity-mcp_manage_editor with Action="GetState"
2. Based on the result, reply with ONLY ONE of these exact formats:
   - If successful: CONNECTED
   - If failed: ERROR: <brief reason>

CRITICAL: Your entire response must be ONLY the word "CONNECTED" or "ERROR: reason". Do not add any explanation, markdown, or other text.`;
            
            const result = await agentRunner.run({
                id: uniqueId,
                prompt: `${basePrompt}

Examples of CORRECT responses:
- CONNECTED
- ERROR: Connection refused
- ERROR: Tool not found

Examples of WRONG responses:
- "The MCP tool returned successfully, so I can confirm: CONNECTED"
- "Based on the result, the status is CONNECTED"
- "ERROR: The connection failed because..."

Reply now with ONLY "CONNECTED" or "ERROR: reason":`,
                cwd: this.workspaceRoot || process.cwd(),
                timeoutMs,
                onOutput: (text, type) => {
                    // Only capture stdout text, ignore stderr warnings
                    if (type === 'text' || type === 'tool_result' || type === 'info') {
                        outputBuffer += text;
                    } else if (type === 'error') {
                        stderrBuffer += text;
                    }
                }
            });
            
            // Write unfiltered output to debug file for troubleshooting
            const fs = require('fs');
            const path = require('path');
            
            // Use workspace logs directory
            const logsDir = path.join(this.workspaceRoot || process.cwd(), '_AiDevLog', 'Logs');
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            const debugLogPath = path.join(logsDir, 'unity_mcp_test.log');
            
            const debugContent = `=== Unity MCP Connectivity Test Debug Log ===
Timestamp: ${new Date().toISOString()}
Unique ID: ${uniqueId}
Exit Code: ${result.exitCode}

=== RAW STDOUT (${outputBuffer.length} chars) ===
${outputBuffer}

=== RAW STDERR (${stderrBuffer.length} chars) ===
${stderrBuffer}

=== END RAW OUTPUT ===
`;
            
            try {
                fs.writeFileSync(debugLogPath, debugContent, 'utf8');
                log.info(`🔍 Raw MCP test output saved to: ${debugLogPath}`);
            } catch (writeErr) {
                log.warn('Failed to write debug log:', writeErr);
            }
            
            // Check if agent completed and parse output
            log.debug(`Agent completed with exit code ${result.exitCode}`);
            log.debug(`Agent stdout (first 500 chars): ${outputBuffer.substring(0, 500)}`);
            if (stderrBuffer) {
                log.debug(`Agent stderr (warnings, first 500 chars): ${stderrBuffer.substring(0, 500)}`);
            }
            
            // Filter out any remaining Cursor CLI warnings from stdout
            // (should be minimal since we filter stderr, but just in case)
            const filteredOutput = outputBuffer
                .split('\n')
                .filter(line => {
                    const lower = line.toLowerCase();
                    return line.trim() && 
                           !lower.includes('warning:') && 
                           !lower.includes('electron/chromium') &&
                           !lower.includes('is not in the list of known options') &&
                           !lower.includes('run with \'cursor -\'');
                })
                .join('\n')
                .trim();
            
            // Log filtered output to debug file
            try {
                fs.appendFileSync(debugLogPath, `
=== FILTERED OUTPUT (${filteredOutput.length} chars) ===
${filteredOutput}

=== FILTERED OUTPUT UPPERCASE ===
${filteredOutput.toUpperCase()}

=== PARSING RESULTS ===
Contains "CONNECTED": ${filteredOutput.toUpperCase().includes('CONNECTED')}
Contains "ERROR": ${filteredOutput.toUpperCase().includes('ERROR')}
Exit code is 0: ${result.exitCode === 0}
`, 'utf8');
            } catch (writeErr) {
                log.warn('Failed to append filtered output to debug log:', writeErr);
            }
            
            const output = filteredOutput.toUpperCase();
            
            // Check for successful connection
            if (output.includes('CONNECTED') && !output.includes('ERROR')) {
                log.debug('Agent reported: CONNECTED');
                return { connected: true };
            }
            
            // Special case: NO OUTPUT but non-zero exit code
            // This means agent crashed before producing any output
            if (filteredOutput.trim().length === 0 && result.exitCode !== 0) {
                log.warn(`Agent crashed with exit code ${result.exitCode} and produced NO output`);
                return {
                    connected: false,
                    error: `Unity MCP server not responding or agent crashed (exit code ${result.exitCode})\n\n` +
                           `Possible causes:\n` +
                           `1. Unity MCP server not running - Start it in Unity:\n` +
                           `   Window → MCP for Unity → Start Local HTTP Server\n` +
                           `2. MCP configuration incorrect - check ~/.cursor/mcp.json\n` +
                           `3. cursor-agent crashed - check logs in _AiDevLog/Logs/`
                };
            }
            
            // Check for explicit error messages or crashes (when there IS output)
            if (output.includes('ERROR') || result.exitCode !== 0) {
                log.debug(`Agent reported: ERROR - ${filteredOutput}`);
                
                // Extract error reason from KNOWN formats ONLY
                // NO fallbacks - if we don't recognize it, THROW with full details
                
                // Format 1: "ERROR: reason"
                const errorMatch = filteredOutput.match(/ERROR:\s*(.+?)(?:\n|$)/i);
                if (errorMatch) {
                    const errorReason = errorMatch[1].trim();
                    return { 
                        connected: false, 
                        error: errorReason
                    };
                }
                
                // Format 2: Unhandled rejection with HTTP 404
                if (filteredOutput.includes('HTTP 404')) {
                    return { 
                        connected: false, 
                        error: 'Unity MCP server not running (HTTP 404)\n\n' +
                               'Start the server in Unity:\n' +
                               'Window → MCP for Unity → Start Local HTTP Server'
                    };
                }
                
                // Format 3: Unhandled rejection (generic)
                if (filteredOutput.includes('unhandledRejection')) {
                    const match = filteredOutput.match(/Error:\s*(.+?)(?:\n|at)/i);
                    if (match) {
                        const errorReason = match[1].trim();
                        return { 
                            connected: false, 
                            error: errorReason
                        };
                    }
                }
                
                // UNKNOWN ERROR FORMAT - Don't hide it, show everything!
                throw new Error(
                    `Unity MCP connectivity test failed with UNKNOWN error format.\n\n` +
                    `Exit code: ${result.exitCode}\n\n` +
                    `RAW OUTPUT (${filteredOutput.length} chars):\n${filteredOutput}\n\n` +
                    `This is a bug - the error parsing needs to be updated to handle this format.`
                );
            }
            
            // NO OUTPUT AND EXIT CODE 0 - This should never happen, something is broken
            throw new Error(
                `Unity MCP connectivity test produced NO RECOGNIZABLE OUTPUT.\n\n` +
                `Exit code: ${result.exitCode}\n` +
                `Raw stdout length: ${outputBuffer.length}\n` +
                `Filtered output length: ${filteredOutput.length}\n\n` +
                `RAW STDOUT:\n${outputBuffer}\n\n` +
                `This indicates cursor-agent is not responding correctly or output format changed.`
            );
        } catch (error) {
            log.warn('Unity MCP connectivity check failed:', error);
            return { 
                connected: false, 
                error: error instanceof Error ? error.message : String(error) 
            };
        }
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

    /**
     * Check all dependencies with optimizations:
     * 1. Progressive updates - UI updates as checks complete
     * 2. Parallel execution - Independent checks run simultaneously
     * 3. Dependency awareness - Skip expensive tests if prerequisites missing
     * 
     * Performance improvements:
     * - Before: ~16s (sequential, no updates until complete)
     * - After: ~5s (parallel + skips unnecessary tests, progressive updates)
     */
    async checkAllDependencies(): Promise<DependencyStatus[]> {
        // Refresh environment before checking
        // This ensures newly installed CLIs are findable even if PATH was updated
        // after VS Code/daemon started
        this.refreshEnvironment();
        
        // Check if we should use cache for this call
        if (this.useCacheForNextCheck && this.hasFreshCache()) {
            log.info('[DependencyService] Using cached results for post-install verification');
            this.useCacheForNextCheck = false;  // Reset flag
            this._onStatusChanged.fire();
            return this.cachedStatus;
        }
        
        const platform = process.platform as 'darwin' | 'win32' | 'linux';
        const dependencies: DependencyStatus[] = [];

        // Helper: Add result and notify immediately (progressive updates)
        const addAndNotify = (result: DependencyStatus) => {
            dependencies.push(result);
            this.cachedStatus = [...dependencies];
            this._onStatusChanged.fire();
            
            // Broadcast progress if callback is set (for real-time UI updates)
            if (this.progressCallback) {
                this.progressCallback(result.name, result);
            }
        };

        // ====================================================================
        // Phase 1: Platform-specific checks (fast, can run in parallel with common deps)
        // ====================================================================
        const platformChecksPromise = (async () => {
            const platformResults: DependencyStatus[] = [];
            
            if (platform === 'darwin') {
                // macOS checks can run in parallel
                const [appleScript, accessibility] = await Promise.all([
                    this.checkAppleScript(),
                    this.checkAccessibilityPermission()
                ]);
                platformResults.push(appleScript, accessibility);
            } else if (platform === 'win32') {
                platformResults.push(await this.checkPowerShell());
            } else if (platform === 'linux') {
                platformResults.push(await this.checkXdotool());
            }
            
            return platformResults;
        })();

        // ====================================================================
        // Phase 2: Common dependencies (run in parallel - no dependencies between them)
        // ====================================================================
        const commonChecksPromise = Promise.all([
            this.checkCursorCli(),
            this.checkCursorAgentCli(),
            this.checkApcCli(),
            this.checkNodeJsInWsl(),    // Node.js in WSL (for apc CLI)
            this.checkApcCliInWsl()     // apc CLI in WSL (for cursor-agent)
        ]);

        // Wait for both phases to complete
        const [platformResults, commonResults] = await Promise.all([
            platformChecksPromise,
            commonChecksPromise
        ]);

        // Add platform results
        platformResults.forEach(addAndNotify);

        // Add common results (extract for dependency checking)
        const [cursorCliResult, cursorAgentResult, apcResult, nodeJsWslResult, apcWslResult] = commonResults;
        addAndNotify(cursorCliResult);
        addAndNotify(cursorAgentResult);
        addAndNotify(apcResult);
        addAndNotify(nodeJsWslResult);
        addAndNotify(apcWslResult);

        // ====================================================================
        // Phase 3: Unity dependencies (expensive, requires cursor-agent)
        // ====================================================================
        if (this.unityEnabled) {
            // Check if we can test Unity MCP (requires cursor-agent)
            if (cursorAgentResult.installed) {
                // cursor-agent available - run the expensive connectivity test
                log.info('✓ cursor-agent found - starting Unity MCP connectivity test (may take 15+ seconds)...');
                const unityMcpResult = await this.checkUnityMcp();
                addAndNotify(unityMcpResult);
            } else {
                // cursor-agent missing - skip expensive test (save 15 seconds!)
                const isRequired = this.isUnityProject();
                log.debug('✗ cursor-agent not installed - skipping Unity MCP connectivity test (saves 15s)');
                
                addAndNotify({
                    name: 'MCP for Unity',
                    installed: false,
                    required: isRequired,
                    description: isRequired
                        ? 'Cannot test connectivity (Cursor Agent CLI required)'
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installUrl: 'https://github.com/CoplayDev/unity-mcp'
                });
            }

            // Unity temp scene check (fast, only for Unity projects)
            if (this.isUnityProject()) {
                const tempSceneResult = await this.checkUnityTempScene();
                addAndNotify(tempSceneResult);
            }
        }

        // Final update
        this.lastCheckTime = Date.now();
        this.cacheTimestamp = Date.now();  // Update cache timestamp
        return dependencies;
    }
    
    /**
     * Check if Unity MCP (CoplayDev/unity-mcp) is available, configured, and connected
     * Performs three checks:
     * 1. Config check - MCP config file has UnityMCP entry
     * 2. Package check - Unity MCP package installed in project
     * 3. Connectivity check - Agent can reach Unity MCP server
     * 
     * Only required if this is a Unity project AND Unity features are enabled
     * 
     * See: https://github.com/CoplayDev/unity-mcp
     */
    private async checkUnityMcp(): Promise<DependencyStatus> {
        // Unity MCP is only required for Unity projects
        const isUnity = this.isUnityProject();
        const isRequired = isUnity && this.unityEnabled;
        
        // Context notes
        const notUnityNote = !isUnity ? ' (not a Unity project)' : '';
        const disabledNote = !this.unityEnabled ? ' (Unity features disabled)' : '';
        const requiredNote = notUnityNote || disabledNote;
        
        try {
            // Step 1: Check MCP config
            const mcpConfig = this.findUnityMcpConfig();
            
            if (!mcpConfig.hasUnityMcp) {
                // Not configured - needs to be installed via cursor-agent (in WSL on Windows)
                const installHint = process.platform === 'win32'
                    ? '❌ Unity MCP not installed in WSL!\n\nClick "Install" to add Unity MCP to cursor-agent (in WSL).'
                    : '❌ Unity MCP not installed!\n\nClick "Install" to add Unity MCP to cursor-agent.';
                
                return {
                    name: 'MCP for Unity',
                    installed: false,
                    required: isRequired,
                    description: isRequired 
                        ? installHint
                        : 'Unity MCP not configured' + requiredNote,
                    platform: 'all',
                    installUrl: 'https://github.com/CoplayDev/unity-mcp',
                    installType: 'unity-mcp'  // Trigger the Install button
                };
            }
            
            // Step 2: Check package installation (only for Unity projects)
            if (isUnity) {
                const packageCheck = this.checkUnityMcpPackageInstalled();
                if (!packageCheck.installed) {
                    return {
                        name: 'MCP for Unity',
                        installed: false,
                        required: isRequired,
                        description: 'MCP configured but package not installed in Unity project',
                        platform: 'all',
                        installUrl: 'https://github.com/CoplayDev/unity-mcp'
                    };
                }
            }
            
            // Step 3: Check connectivity via agent (only if required AND in daemon context)
            if (isRequired) {
                // Check if we're in a context that can run connectivity tests
                // Extension context can't spawn agents, so skip the test there
                const canRunConnectivityTest = ServiceLocator.isRegistered(AgentRunner);
                
                if (!canRunConnectivityTest) {
                    // Extension context - config and package exist, mark as satisfied
                    // The daemon will do the real connectivity test
                    log.debug('Unity MCP configured - connectivity test will run in daemon context');
                    return {
                        name: 'MCP for Unity',
                        installed: true,  // Config exists, package installed
                        required: isRequired,
                        description: 'MCP for Unity configured (daemon will verify connectivity)',
                        platform: 'all',
                        installUrl: 'https://github.com/CoplayDev/unity-mcp'
                    };
                }
                
                // Daemon context - run the full connectivity test with smart auth handling
                // But first, check and auto-create temp scene if needed
                log.info('🔌 Testing Unity MCP connectivity (this takes ~15 seconds)...');
                
                // Step 3a: Check temp scene before connectivity test
                const tempScenePath = path.join(this.workspaceRoot || process.cwd(), 'Assets/Scenes/_TempCompileCheck.unity');
                let tempSceneExists = fs.existsSync(tempScenePath);
                const maxAttempts = 3;
                let attempt = 0;
                
                // Try to create temp scene if missing (max 3 attempts)
                while (!tempSceneExists && attempt < maxAttempts) {
                    attempt++;
                    log.info(`📋 Temp scene missing, attempting to create via MCP (attempt ${attempt}/${maxAttempts})...`);
                    
                    const createResult = await this.testUnityMcpConnectionSmart(false, true); // tryCreateTempScene=true
                    
                    if (createResult.connected) {
                        log.info('✅ Temp scene creation request sent successfully');
                        // Wait a bit for Unity to create the scene
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        tempSceneExists = fs.existsSync(tempScenePath);
                        
                        if (tempSceneExists) {
                            log.info('✅ Temp scene created successfully!');
                            break;
                        } else {
                            log.warn(`⚠️  MCP call succeeded but temp scene not found (attempt ${attempt}/${maxAttempts})`);
                        }
                    } else {
                        log.warn(`✗ Failed to create temp scene (attempt ${attempt}/${maxAttempts}): ${createResult.error}`);
                        break; // If MCP connection fails, don't retry
                    }
                }
                
                // If temp scene still missing after all attempts, log warning but continue
                if (!tempSceneExists) {
                    log.warn('⚠️  Temp scene creation failed - some Unity Control features may not work');
                }
                
                // Step 3b: Run connectivity test
                const connectivityResult = await this.testUnityMcpConnectionSmart(false); // interactive=false for background check
                
                if (!connectivityResult.connected) {
                    log.warn(`✗ Unity MCP connectivity test FAILED: ${connectivityResult.error || 'Unity Editor not responding'}`);
                    
                    // Check if it's an auth issue
                    if (connectivityResult.requiresLogin) {
                        return {
                            name: 'MCP for Unity',
                            installed: false,
                            required: isRequired,
                            description: `Authentication required: ${connectivityResult.error || 'Please login to cursor-agent'}`,
                            platform: 'all',
                            installCommand: 'cursor-agent login',
                            installUrl: 'https://github.com/CoplayDev/unity-mcp',
                            installType: 'cursor-agent-cli'
                        };
                    }
                    
                    return {
                        name: 'MCP for Unity',
                        installed: false,
                        required: isRequired,
                        description: connectivityResult.error 
                            ? `⚠️ Configured but not responding: ${connectivityResult.error}\n\n` +
                              `Unity MCP is installed but the server is not running.\n` +
                              `In Unity: Window → MCP for Unity → Start Local HTTP Server`
                            : '⚠️ Configured but Unity Editor not responding\n\n' +
                              'In Unity: Window → MCP for Unity → Start Local HTTP Server',
                        platform: 'all',
                        installUrl: 'https://github.com/CoplayDev/unity-mcp',
                        installType: 'retry'
                    };
                }
                
                // All checks passed - connected!
                log.info('✅ Unity MCP connectivity test PASSED - Connected to Unity Editor');
                return {
                    name: 'MCP for Unity',
                    installed: true,
                    required: isRequired,
                    description: 'Connected to Unity Editor',
                    platform: 'all',
                    installUrl: 'https://github.com/CoplayDev/unity-mcp'
                };
            }
            
            // Config exists but not required - mark as configured (not connected)
            return {
                name: 'MCP for Unity',
                installed: true,
                required: isRequired,
                description: 'MCP for Unity configured' + requiredNote,
                platform: 'all',
                installUrl: 'https://github.com/CoplayDev/unity-mcp'
            };
            
        } catch (error) {
            return {
                name: 'MCP for Unity',
                installed: false,
                required: isRequired,
                description: `Error checking Unity MCP: ${error}`,
                platform: 'all',
                installUrl: 'https://github.com/CoplayDev/unity-mcp'
            };
        }
    }
    
    /**
     * Check if Unity temp scene exists for prep_editor
     * Only checked for Unity projects
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
        
        // Only relevant for Unity projects
        if (!this.isUnityProject()) {
            return {
                name: 'Unity Temp Scene',
                installed: false,
                required: false,
                description: 'Not applicable (not a Unity project)',
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
                description: 'Assets/Scenes folder not found',
                platform: 'all'
            };
        }
    }

    private async checkApcCli(): Promise<DependencyStatus> {
        const platform = process.platform;
        
        // First, check if the file exists at the expected installation location
        // This is more reliable than `where`/`which` because:
        // 1. The PATH might not be updated in the current process
        // 2. We know exactly where we install it
        const expectedPath = platform === 'win32'
            ? path.join(os.homedir(), 'bin', 'apc.cmd')
            : path.join(os.homedir(), '.local', 'bin', 'apc');
        
        if (fs.existsSync(expectedPath)) {
            // File exists - now verify it points to the correct extension path
            const isValid = await this.verifyApcCliPath(expectedPath);
            
            if (!isValid) {
                log.warn('APC CLI exists but points to wrong extension path (dev vs installed)');
                return {
                    name: 'APC CLI (apc)',
                    installed: false,
                    required: true,
                    description: 'apc CLI needs update - points to old extension location',
                    platform: 'all'
                };
            }
            
            return {
                name: 'APC CLI (apc)',
                installed: true,
                required: true,
                description: 'apc command-line tool for AI agents',
                platform: 'all'
            };
        }
        
        // Also check PATH in case apc is installed elsewhere
        // This is explicit secondary check, not a silent fallback
        log.debug('APC not found at expected location, checking PATH...');
        try {
            const checkCmd = platform === 'win32' ? 'where apc 2>nul' : 'which apc';
            await execAsync(checkCmd);
            log.info('APC CLI found in PATH (non-standard location)');
            return {
                name: 'APC CLI (apc)',
                installed: true,
                required: true,
                description: 'apc command-line tool for AI agents (found in PATH)',
                platform: 'all'
            };
        } catch {
            return {
                name: 'APC CLI (apc)',
                installed: false,
                required: true,
                description: platform === 'win32' 
                    ? 'Click to install → creates apc.cmd in ~/bin'
                    : 'Click to install → creates apc command in ~/.local/bin',
                platform: 'all'
            };
        }
    }

    /**
     * Verify that the APC CLI wrapper points to a valid extension path
     * Returns false if it points to a non-existent location (dev → installed transition)
     */
    private async verifyApcCliPath(wrapperPath: string): Promise<boolean> {
        try {
            const content = fs.readFileSync(wrapperPath, 'utf-8');
            const platform = process.platform;
            
            if (platform === 'win32') {
                // Windows: Extract path from: node "C:\path\to\apc.js" %*
                const match = content.match(/node\s+"([^"]+)"/);
                if (match && match[1]) {
                    const targetPath = match[1].replace(/\\\\/g, '\\'); // Unescape
                    if (!fs.existsSync(targetPath)) {
                        log.warn(`APC CLI points to non-existent file: ${targetPath}`);
                        return false;
                    }
                }
            } else {
                // Unix: Extract path from: exec node "/path/to/apc.js" "$@"
                const match = content.match(/exec node "([^"]+)"/);
                if (match && match[1]) {
                    const targetPath = match[1];
                    if (!fs.existsSync(targetPath)) {
                        log.warn(`APC CLI points to non-existent file: ${targetPath}`);
                        return false;
                    }
                }
            }
            
            return true;
        } catch (error) {
            log.error('Failed to verify APC CLI path:', error);
            return false; // Treat as invalid if we can't read it
        }
    }

    async installApcCli(extensionPath: string): Promise<{ success: boolean; message: string }> {
        const platform = process.platform;
        // Source is now the Node.js CLI script
        const sourcePath = path.join(extensionPath, 'scripts', 'apc.js');
        
        // Check if source exists
        if (!fs.existsSync(sourcePath)) {
            return {
                success: false,
                message: `APC CLI source not found at ${sourcePath}. Make sure the extension is properly installed.`
            };
        }
        
        // Determine target directory
        let targetDir: string;
        let targetPath: string;
        
        if (platform === 'win32') {
            // Windows: Create ~/bin directory with apc.cmd wrapper
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
                // Windows: Create a .cmd wrapper that calls Node.js with the script
                // Use %~dp0 to get the directory where apc.cmd is located (for portable paths)
                // But since we reference the extension's script path, we use absolute path
                const cmdContent = `@echo off\r\nnode "${sourcePath.replace(/\\/g, '\\\\')}" %*`;
                fs.writeFileSync(targetPath, cmdContent, 'utf-8');
            } else {
                // Unix: Create a shell script wrapper (not symlink, for better compatibility)
                // Use lstat to detect broken symlinks (existsSync returns false for broken symlinks)
                try {
                    fs.lstatSync(targetPath);
                    // File or symlink exists - remove it
                    fs.unlinkSync(targetPath);
                } catch {
                    // Path doesn't exist - that's fine
                }
                
                // Create shell script wrapper
                const shContent = `#!/bin/sh\nexec node "${sourcePath}" "$@"\n`;
                fs.writeFileSync(targetPath, shContent, { mode: 0o755 });
            }

            // Check if targetDir is in PATH
            const pathEnv = process.env.PATH || '';
            const pathDirs = pathEnv.split(path.delimiter).map(p => p.toLowerCase());
            const inPath = pathDirs.includes(targetDir.toLowerCase());

            if (!inPath) {
                if (platform === 'win32') {
                    // On Windows, automatically add to User PATH environment variable
                    try {
                        const { execSync } = require('child_process');
                        const getUserPath = `[Environment]::GetEnvironmentVariable("Path", "User")`;
                        const currentUserPath = execSync(`powershell -Command "${getUserPath}"`, {
                            encoding: 'utf-8',
                            windowsHide: true
                        }).trim();
                        
                        // Check again in the actual User PATH (not just current session)
                        if (!currentUserPath.toLowerCase().includes(targetDir.toLowerCase())) {
                            // Escape backslashes for PowerShell command
                            const escapedCurrentPath = currentUserPath.replace(/\\/g, '\\\\');
                            const escapedTargetDir = targetDir.replace(/\\/g, '\\\\');
                            const setPathCmd = `[Environment]::SetEnvironmentVariable("Path", "${escapedCurrentPath};${escapedTargetDir}", "User")`;
                            execSync(`powershell -Command "${setPathCmd}"`, { windowsHide: true });
                            
                            return {
                                success: true,
                                message: `APC CLI installed to ${targetPath}.\n\n✓ Added ${targetDir} to User PATH\n\nPlease restart your terminal or VS Code for the PATH change to take effect.`
                            };
                        }
                    } catch (error) {
                        log.warn(`Could not automatically add to PATH: ${error}`);
                        return {
                            success: true,
                            message: `APC CLI installed to ${targetPath}.\n\nPlease manually add ${targetDir} to your PATH:\n1. Open System Properties > Environment Variables\n2. Edit PATH and add: ${targetDir}\n3. Restart your terminal`
                        };
                    }
                } else {
                    const shellConfig = platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
                    return {
                        success: true,
                        message: `APC CLI installed to ${targetPath}.\n\nAdd to PATH by running:\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ${shellConfig}\n\nThen restart your terminal or run: source ${shellConfig}`
                    };
                }
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
    
    /**
     * Enable cache for the next dependency check only
     * Used after installation to speed up verification
     */
    enableCacheForNextCheck(): void {
        this.useCacheForNextCheck = true;
        log.info('[DependencyService] Cache enabled for next check');
    }
    
    /**
     * Check if cached results are available
     */
    private hasFreshCache(): boolean {
        return this.cachedStatus.length > 0 && this.cacheTimestamp > 0;
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

    // Note: checkPython() removed - Python is no longer required
    // The coordinator was migrated from Python to TypeScript

    /**
     * Check Cursor CLI (basic 'cursor' command - IDE subcommand)
     * 
     * NOTE: This is NOT required anymore!
     * We use cursor-agent (standalone CLI) instead, which is checked by checkCursorAgentCli()
     * 
     * This check is kept for informational purposes only.
     */
    private async checkCursorCli(): Promise<DependencyStatus> {
        // Cursor IDE CLI is NOT required - we use cursor-agent instead
        const isRequired = false;
        
        try {
            const { stdout } = await execAsync('cursor --version');
            return {
                name: 'Cursor CLI',
                installed: true,
                version: stdout.trim().split('\n')[0], // First line contains version
                required: isRequired,
                description: 'Not required (using cursor-agent instead)',
                platform: 'all',
                installUrl: 'cursor://settings/cli'
            };
        } catch {
            return {
                name: 'Cursor CLI',
                installed: false,
                required: isRequired,
                description: 'Not required (using cursor-agent instead)',
                platform: 'all',
                installUrl: 'cursor://settings/cli'
            };
        }
    }

    /**
     * Check Cursor Agent CLI (cursor-agent standalone tool)
     * This is REQUIRED for running AI agents (cursor backend)
     * See: https://cursor.com/docs/cli/installation
     * 
     * IMPORTANT: cursor-agent is different from 'cursor agent' IDE subcommand
     * We use cursor-agent for its advanced features (session management, MCP support)
     * 
     * On Windows: cursor-agent requires WSL (Windows Subsystem for Linux)
     */
    private async checkCursorAgentCli(): Promise<DependencyStatus> {
        // Determine if cursor backend is being used
        const backendType = this.getCurrentBackendType();
        const isRequired = (backendType === 'cursor');
        
        log.debug('[checkCursorAgentCli] Starting check, platform:', process.platform);
        log.debug('[checkCursorAgentCli] Required:', isRequired, 'Backend:', backendType);
        
        // ====================================================================
        // Platform-specific check strategy:
        // - Windows: ONLY check WSL (we REQUIRE WSL + mirrored mode)
        // - macOS/Linux: Check native PATH (cursor-agent runs natively)
        // ====================================================================
        
        if (process.platform === 'win32') {
            // WINDOWS: cursor-agent MUST be in WSL
            log.debug('[checkCursorAgentCli] Windows - checking WSL (required)');
            
            // Step 1: Verify WSL is available
            try {
                await execAsync('wsl --version', { timeout: 2000 });
                log.debug('[checkCursorAgentCli] WSL is available');
            } catch (wslError) {
                log.error('[checkCursorAgentCli] WSL not available:', wslError);
                return {
                    name: 'Cursor Agent CLI',
                    installed: false,
                    required: isRequired,
                    description: isRequired
                        ? '❌ WSL not installed! cursor-agent requires WSL on Windows.\n\nClick Install to run the automated setup script.'
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installUrl: 'https://cursor.com/docs/cli/installation',
                    installType: 'cursor-agent-cli'
                };
            }
            
            // Step 2: Check if cursor-agent exists in WSL
            // Use spawnSync instead of execSync to avoid cmd.exe and quoting issues
            try {
                log.debug('[checkCursorAgentCli] Checking for cursor-agent in WSL...');
                
                // Use spawnSync to call wsl.exe directly (avoids cmd.exe shell parsing issues)
                const result = spawnSync(
                    'wsl',
                    [
                        '-d', 'Ubuntu',
                        'bash', '-c',
                        'if [ -f ~/.local/bin/cursor-agent ]; then ~/.local/bin/cursor-agent --version 2>&1; else echo NOT_FOUND; fi'
                    ],
                    { 
                        encoding: 'utf8',
                        timeout: 15000,  // 15 seconds
                        maxBuffer: 1024 * 1024,  // 1MB buffer
                        windowsHide: true
                    }
                );
                
                // spawnSync returns output in stdout/stderr properties, and status/error
                const fileCheck = (result.stdout || '').trim();
                const errorOutput = (result.stderr || '').trim();
                
                log.debug('[checkCursorAgentCli] WSL check result:', fileCheck);
                if (errorOutput) {
                    log.debug('[checkCursorAgentCli] WSL stderr:', errorOutput);
                }
                
                // Check for errors
                if (result.error) {
                    throw result.error;
                }
                
                if (!fileCheck || fileCheck.includes('NOT_FOUND') || !fileCheck.trim()) {
                log.warn('[checkCursorAgentCli] cursor-agent not found in WSL');
                return {
                    name: 'Cursor Agent CLI',
                    installed: false,
                    required: isRequired,
                    description: isRequired
                        ? '❌ cursor-agent not installed in WSL!\n\n' +
                          'WHAT IT DOES:\n' +
                          '• Runs AI agents via Cursor backend\n' +
                          '• Connects to Unity MCP on Windows\n\n' +
                          'INSTALLATION:\n' +
                          '• Click Install to run automated setup\n' +
                          '• Requires admin privileges for WSL\n' +
                          '• Installs WSL, Ubuntu, cursor-agent, Node.js, apc CLI\n\n' +
                          '📖 Documentation: https://cursor.com/docs/cli/installation'
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installUrl: 'https://cursor.com/docs/cli/installation',
                    installType: 'cursor-agent-cli'
                };
                }
                
                log.info('[checkCursorAgentCli] cursor-agent found in WSL:', fileCheck.split('\n')[0]);
                
                // Step 3: Verify WSL mirrored mode is enabled (REQUIRED for Unity MCP)
                const mirroredModeCheck = this.checkWslMirroredMode();
                
                if (!mirroredModeCheck.enabled) {
                    log.warn('[checkCursorAgentCli] WSL mirrored mode not enabled!');
                    return {
                        name: 'Cursor Agent CLI',
                        installed: false,  // Mark as NOT installed because it won't work properly
                        required: isRequired,
                        description: isRequired
                            ? `❌ WSL mirrored mode REQUIRED but not enabled!\n\n${mirroredModeCheck.error}\n\nClick Install to run the setup script that will configure WSL properly.`
                            : 'WSL mirrored mode not enabled (required for Unity MCP connectivity)',
                        platform: 'all',
                        installUrl: 'https://cursor.com/docs/cli/installation',
                        installType: 'cursor-agent-cli'
                    };
                }
                
                // SUCCESS: cursor-agent + mirrored mode enabled
                log.info('[checkCursorAgentCli] ✅ cursor-agent + WSL mirrored mode verified');
                return {
                    name: 'Cursor Agent CLI',
                    installed: true,
                    version: `${fileCheck.split('\n')[0]} (in WSL)`,
                    required: isRequired,
                    description: isRequired
                        ? '✅ Installed in WSL with mirrored networking - ready for cursor backend'
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installCommand: 'curl https://cursor.com/install -fsS | bash',
                    installUrl: 'https://cursor.com/docs/cli/installation'
                };
                
            } catch (checkError: any) {
                // Handle errors
                log.error('[checkCursorAgentCli] cursor-agent check failed:', checkError);
                
                // Check if this is a timeout error
                if (checkError.code === 'ETIMEDOUT') {
                    log.warn('[checkCursorAgentCli] WSL command timed out - WSL may be slow or unresponsive');
                    return {
                        name: 'Cursor Agent CLI',
                        installed: false,
                        required: isRequired,
                        description: isRequired
                            ? '❌ WSL check timed out - WSL may be slow or not responding.\n\nTry:\n1. Restart WSL: wsl --shutdown\n2. Check WSL status: wsl --status\n3. Click Install to run the setup script'
                            : 'Not needed (cursor backend not in use)',
                        platform: 'all',
                        installUrl: 'https://cursor.com/docs/cli/installation',
                        installType: 'cursor-agent-cli'
                    };
                }
                
                return {
                    name: 'Cursor Agent CLI',
                    installed: false,
                    required: isRequired,
                    description: isRequired
                        ? `❌ Failed to check cursor-agent in WSL: ${checkError.message || String(checkError)}`
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installUrl: 'https://cursor.com/docs/cli/installation',
                    installType: 'cursor-agent-cli'
                };
            }
        } else {
            // macOS/Linux: Check native PATH
            log.debug('[checkCursorAgentCli] macOS/Linux - checking native PATH');
            
            try {
                const { stdout } = await execAsync('cursor-agent --version', { timeout: 5000 });
                log.info('[checkCursorAgentCli] ✅ cursor-agent found:', stdout.trim().split('\n')[0]);
                return {
                    name: 'Cursor Agent CLI',
                    installed: true,
                    version: stdout.trim().split('\n')[0],
                    required: isRequired,
                    description: isRequired
                        ? '✅ Installed and ready for cursor backend'
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installCommand: 'curl https://cursor.com/install -fsS | bash',
                    installUrl: 'https://cursor.com/docs/cli/installation'
                };
            } catch (nativeError) {
                log.warn('[checkCursorAgentCli] cursor-agent not found in PATH');
                return {
                    name: 'Cursor Agent CLI',
                    installed: false,
                    required: isRequired,
                    description: isRequired
                        ? '❌ cursor-agent not installed!\n\nRun: curl https://cursor.com/install -fsS | bash'
                        : 'Not needed (cursor backend not in use)',
                    platform: 'all',
                    installCommand: 'curl https://cursor.com/install -fsS | bash',
                    installUrl: 'https://cursor.com/docs/cli/installation'
                };
            }
        }
    }

    /**
     * Check if Node.js is installed in WSL (required for apc CLI to work in WSL)
     * Only relevant on Windows with WSL
     */
    private async checkNodeJsInWsl(): Promise<DependencyStatus> {
        if (process.platform !== 'win32') {
            // Not applicable on non-Windows platforms
            return {
                name: 'Node.js in WSL',
                installed: true,  // N/A, mark as installed
                required: false,
                description: 'Not applicable (not using WSL)',
                platform: 'all'
            };
        }

        log.debug('[checkNodeJsInWsl] Checking Node.js in WSL...');

        try {
            // Check if Node.js is available in WSL
            const result = spawnSync(
                'wsl',
                ['-d', 'Ubuntu', 'bash', '-c', 'node --version 2>&1'],
                { 
                    encoding: 'utf8',
                    timeout: 10000,
                    windowsHide: true
                }
            );

            const output = (result.stdout || '').trim();
            const errorOutput = (result.stderr || '').trim();

            log.debug('[checkNodeJsInWsl] Check result:', output);
            if (errorOutput) {
                log.debug('[checkNodeJsInWsl] stderr:', errorOutput);
            }

            if (result.error) {
                throw result.error;
            }

            // Check if Node.js version was returned
            if (output && output.match(/v\d+\.\d+\.\d+/)) {
                log.info('[checkNodeJsInWsl] ✅ Node.js found in WSL:', output);
                return {
                    name: 'Node.js in WSL',
                    installed: true,
                    version: output,
                    required: true,
                    description: '✅ Required for apc CLI in WSL',
                    platform: 'all'
                };
            } else {
                log.warn('[checkNodeJsInWsl] Node.js not found in WSL');
                return {
                    name: 'Node.js in WSL',
                    installed: false,
                    required: true,
                    description: '❌ Node.js not installed in WSL!\n\n' +
                                 'REQUIRED FOR:\n' +
                                 '• apc CLI to work in WSL\n' +
                                 '• cursor-agent to call apc commands\n\n' +
                                 'INSTALLATION:\n' +
                                 '• Click Install to run automated setup\n' +
                                 '• Same installer as cursor-agent (one-stop setup)\n\n' +
                                 '📖 Documentation: https://cursor.com/docs/cli/installation',
                    platform: 'all',
                    installType: 'cursor-agent-cli'
                };
            }
        } catch (error: any) {
            log.error('[checkNodeJsInWsl] Check failed:', error);
            return {
                name: 'Node.js in WSL',
                installed: false,
                required: true,
                description: `❌ Failed to check Node.js in WSL: ${error.message || String(error)}`,
                platform: 'all',
                installType: 'cursor-agent-cli'
            };
        }
    }

    /**
     * Check if apc CLI is installed in WSL (required for cursor-agent to call apc commands)
     * Only relevant on Windows with WSL
     */
    private async checkApcCliInWsl(): Promise<DependencyStatus> {
        if (process.platform !== 'win32') {
            // Not applicable on non-Windows platforms
            return {
                name: 'apc CLI in WSL',
                installed: true,  // N/A, mark as installed
                required: false,
                description: 'Not applicable (not using WSL)',
                platform: 'all'
            };
        }

        log.debug('[checkApcCliInWsl] Checking apc CLI in WSL...');

        try {
            // Check if apc CLI is available in WSL
            const result = spawnSync(
                'wsl',
                ['-d', 'Ubuntu', 'bash', '-c', 'if [ -f ~/.local/bin/apc ]; then echo FOUND; else echo NOT_FOUND; fi'],
                { 
                    encoding: 'utf8',
                    timeout: 10000,
                    windowsHide: true
                }
            );

            const output = (result.stdout || '').trim();
            const errorOutput = (result.stderr || '').trim();

            log.debug('[checkApcCliInWsl] Check result:', output);
            if (errorOutput) {
                log.debug('[checkApcCliInWsl] stderr:', errorOutput);
            }

            if (result.error) {
                throw result.error;
            }

            if (output && output === 'FOUND') {
                log.info('[checkApcCliInWsl] ✅ apc CLI found in WSL');
                return {
                    name: 'apc CLI in WSL',
                    installed: true,
                    required: true,
                    description: '✅ Allows cursor-agent to call apc commands from WSL',
                    platform: 'all'
                };
            } else {
                log.warn('[checkApcCliInWsl] apc CLI not found in WSL');
                return {
                    name: 'apc CLI in WSL',
                    installed: false,
                    required: true,
                    description: '❌ apc CLI not installed in WSL!\n\n' +
                                 'REQUIRED FOR:\n' +
                                 '• cursor-agent to execute apc commands from WSL\n' +
                                 '• Agent workflows to work properly\n\n' +
                                 'INSTALLATION:\n' +
                                 '• Click Install to run automated setup\n' +
                                 '• Creates wrapper at ~/.local/bin/apc in WSL\n\n' +
                                 '📖 Documentation: https://cursor.com/docs/cli/installation',
                    platform: 'all',
                    installType: 'cursor-agent-cli'
                };
            }
        } catch (error: any) {
            log.error('[checkApcCliInWsl] Check failed:', error);
            return {
                name: 'apc CLI in WSL',
                installed: false,
                required: true,
                description: `❌ Failed to check apc CLI in WSL: ${error.message || String(error)}`,
                platform: 'all',
                installType: 'cursor-agent-cli'
            };
        }
    }

    /**
     * Get the current backend type from configuration
     * This determines which CLI tools are actually required
     */
    private getCurrentBackendType(): string {
        // Try to get from daemon config first (most authoritative)
        try {
            const configPath = path.join(
                this.workspaceRoot || process.cwd(),
                '_AiDevLog',
                '.config',
                'daemon.json'
            );
            
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (config.defaultBackend) {
                    return config.defaultBackend;
                }
            }
        } catch (e) {
            // Ignore errors, fall through to defaults
        }
        
        // Default to 'cursor' since it's currently the only supported backend
        return 'cursor';
    }

    async openInstallUrl(dep: DependencyStatus): Promise<void> {
        if (dep.installUrl && this.vscodeIntegration.openExternal) {
            await this.vscodeIntegration.openExternal(dep.installUrl);
        } else if (dep.installUrl) {
            log.info(`Open URL to install: ${dep.installUrl}`);
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
                log.info(`Install command: ${dep.installCommand}`);
            }
        }
    }
    
    // ========================================================================
    // Periodic Check Methods
    // ========================================================================
    
    /**
     * Start periodic dependency checking
     * 
     * ⚠️ NOT RECOMMENDED for normal use:
     * - Dependencies rarely change during runtime
     * - Unity MCP connectivity test takes ~15 seconds (expensive!)
     * - Better to check on-demand (install/uninstall events, manual refresh)
     * 
     * Use cases for periodic checks:
     * - Development/testing environments
     * - Monitoring dashboard scenarios
     * 
     * @param intervalMs Interval in milliseconds between checks (default: 30000)
     */
    startPeriodicCheck(intervalMs: number = 30000): void {
        // Stop any existing timer
        this.stopPeriodicCheck();
        
        log.info(`Starting periodic check every ${intervalMs / 1000}s`);
        log.warn('Periodic checks include expensive Unity MCP connectivity test (~15s)');
        
        this.periodicCheckTimer = setInterval(async () => {
            try {
                const previousStatus = [...this.cachedStatus];
                await this.checkAllDependencies();
                
                // Check if status changed
                const statusChanged = this.hasStatusChanged(previousStatus, this.cachedStatus);
                if (statusChanged) {
                    log.info('Dependency status changed');
                    this._onStatusChanged.fire();
                }
            } catch (e) {
                log.warn('Periodic check failed:', e);
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
            log.info('Stopped periodic check');
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
            '_AiDevLog/Plans',              // Per-plan storage (includes per-plan tasks.json)
            '_AiDevLog/Logs',
            '_AiDevLog/Logs/Coordinator',   // Global coordinator evaluation logs
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

