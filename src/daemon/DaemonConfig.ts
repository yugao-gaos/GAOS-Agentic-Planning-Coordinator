/**
 * DaemonConfig.ts - Configuration loader for APC daemon
 * 
 * This module provides configuration loading without vscode dependencies.
 * Configuration can come from:
 * 1. Config file (<working_dir>/.config/daemon.json)
 * 2. Environment variables
 * 3. Default values
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Configuration Interface
// ============================================================================

/**
 * Core configuration for APC daemon and services.
 * This replaces vscode.workspace.getConfiguration('agenticPlanning')
 */
export interface CoreConfig {
    /** Workspace root path */
    workspaceRoot: string;
    
    /** Working directory for plans, logs, state (_AiDevLog by default) */
    workingDirectory: string;
    
    /** Total number of agents in the pool */
    agentPoolSize: number;
    
    /** Default AI backend */
    defaultBackend: 'cursor';
    
    /** State update interval in milliseconds */
    stateUpdateInterval: number;
    
    /** Whether Unity features are enabled */
    enableUnityFeatures: boolean;
    
    /** Daemon port */
    port: number;
    
    /** Log level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Omit<CoreConfig, 'workspaceRoot'> = {
    workingDirectory: '_AiDevLog',
    agentPoolSize: 10,
    defaultBackend: 'cursor',
    stateUpdateInterval: 5000,
    enableUnityFeatures: true,  // Unity enabled by default
    port: 19840,
    logLevel: 'info'
};

// ============================================================================
// Configuration Loader
// ============================================================================

/**
 * Load configuration from various sources
 */
export class ConfigLoader {
    private config: CoreConfig;
    private configPath: string;
    private changeCallbacks: Array<(config: CoreConfig) => void> = [];
    
    constructor(workspaceRoot: string) {
        // Config now stored in .config/ folder
        this.configPath = path.join(workspaceRoot, '_AiDevLog', '.config', 'daemon.json');
        // Migrate from old locations if needed
        this.migrateConfig(workspaceRoot);
        this.config = this.loadConfig(workspaceRoot);
    }
    
    /**
     * Register a callback for configuration changes
     */
    onChange(callback: (config: CoreConfig) => void): () => void {
        this.changeCallbacks.push(callback);
        // Return unsubscribe function
        return () => {
            const index = this.changeCallbacks.indexOf(callback);
            if (index >= 0) {
                this.changeCallbacks.splice(index, 1);
            }
        };
    }
    
    /**
     * Notify all callbacks of configuration change
     */
    private notifyChange(): void {
        for (const callback of this.changeCallbacks) {
            try {
                callback(this.getConfig());
            } catch (err) {
                console.error('ConfigLoader: Error in change callback:', err);
            }
        }
    }
    
    /**
     * Get the loaded configuration
     */
    getConfig(): CoreConfig {
        return { ...this.config };
    }
    
    /**
     * Get a specific configuration value
     */
    get<K extends keyof CoreConfig>(key: K): CoreConfig[K] {
        return this.config[key];
    }
    
    /**
     * Update configuration (persists to file and notifies listeners)
     */
    set<K extends keyof CoreConfig>(key: K, value: CoreConfig[K]): void {
        this.config[key] = value;
        this.saveConfig();
        this.notifyChange();
    }
    
    /**
     * Update multiple config values at once
     */
    update(updates: Partial<CoreConfig>): void {
        Object.assign(this.config, updates);
        this.saveConfig();
        this.notifyChange();
    }
    
    /**
     * Reset configuration to defaults
     */
    reset(): void {
        this.config = {
            workspaceRoot: this.config.workspaceRoot,
            ...DEFAULT_CONFIG
        };
        this.saveConfig();
        this.notifyChange();
    }
    
    /**
     * Reset a specific config value to default
     */
    resetKey<K extends keyof CoreConfig>(key: K): void {
        if (key === 'workspaceRoot') {
            return; // Can't reset workspace root
        }
        this.config[key] = DEFAULT_CONFIG[key] as any;
        this.saveConfig();
        this.notifyChange();
    }
    
    /**
     * Reload configuration from file
     */
    reload(): void {
        this.config = this.loadConfig(this.config.workspaceRoot);
    }
    
    /**
     * Get the full working directory path
     */
    getWorkingDir(): string {
        return path.join(this.config.workspaceRoot, this.config.workingDirectory);
    }
    
    /**
     * Load configuration from file and environment
     */
    private loadConfig(workspaceRoot: string): CoreConfig {
        // Start with defaults
        const config: CoreConfig = {
            workspaceRoot,
            ...DEFAULT_CONFIG
        };
        
        // Load from config file if exists
        if (fs.existsSync(this.configPath)) {
            try {
                const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                Object.assign(config, this.sanitizeConfig(fileConfig));
            } catch (err) {
                console.warn(`Failed to load config from ${this.configPath}:`, err);
            }
        }
        
        // Override with environment variables
        this.applyEnvironmentOverrides(config);
        
        return config;
    }
    
    /**
     * Sanitize loaded configuration
     */
    private sanitizeConfig(raw: any): Partial<CoreConfig> {
        const sanitized: Partial<CoreConfig> = {};
        
        if (typeof raw.workingDirectory === 'string') {
            sanitized.workingDirectory = raw.workingDirectory;
        }
        
        if (typeof raw.agentPoolSize === 'number' && raw.agentPoolSize >= 1 && raw.agentPoolSize <= 20) {
            sanitized.agentPoolSize = raw.agentPoolSize;
        }
        
        if (raw.defaultBackend === 'cursor') {
            sanitized.defaultBackend = raw.defaultBackend;
        }
        
        if (typeof raw.stateUpdateInterval === 'number' && raw.stateUpdateInterval >= 1000) {
            sanitized.stateUpdateInterval = raw.stateUpdateInterval;
        }
        
        if (typeof raw.enableUnityFeatures === 'boolean') {
            sanitized.enableUnityFeatures = raw.enableUnityFeatures;
        }
        
        if (typeof raw.port === 'number' && raw.port >= 1024 && raw.port <= 65535) {
            sanitized.port = raw.port;
        }
        
        if (['debug', 'info', 'warn', 'error'].includes(raw.logLevel)) {
            sanitized.logLevel = raw.logLevel;
        }
        
        return sanitized;
    }
    
    /**
     * Apply environment variable overrides
     */
    private applyEnvironmentOverrides(config: CoreConfig): void {
        // APC_WORKING_DIR
        if (process.env.APC_WORKING_DIR) {
            config.workingDirectory = process.env.APC_WORKING_DIR;
        }
        
        // APC_POOL_SIZE
        if (process.env.APC_POOL_SIZE) {
            const size = parseInt(process.env.APC_POOL_SIZE, 10);
            if (!isNaN(size) && size >= 1 && size <= 20) {
                config.agentPoolSize = size;
            }
        }
        
        // APC_PORT
        if (process.env.APC_PORT) {
            const port = parseInt(process.env.APC_PORT, 10);
            if (!isNaN(port) && port >= 1024 && port <= 65535) {
                config.port = port;
            }
        }
        
        // APC_LOG_LEVEL
        if (process.env.APC_LOG_LEVEL && ['debug', 'info', 'warn', 'error'].includes(process.env.APC_LOG_LEVEL)) {
            config.logLevel = process.env.APC_LOG_LEVEL as CoreConfig['logLevel'];
        }
        
        // APC_ENABLE_UNITY
        if (process.env.APC_ENABLE_UNITY !== undefined) {
            config.enableUnityFeatures = process.env.APC_ENABLE_UNITY !== 'false';
        }
    }
    
    /**
     * Save configuration to file
     */
    private saveConfig(): void {
        try {
            // Ensure .config directory exists
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            // Only save non-default values
            const toSave: Partial<CoreConfig> = {};
            const defaults = DEFAULT_CONFIG as any;
            
            for (const [key, value] of Object.entries(this.config)) {
                if (key !== 'workspaceRoot' && value !== defaults[key]) {
                    (toSave as any)[key] = value;
                }
            }
            
            fs.writeFileSync(this.configPath, JSON.stringify(toSave, null, 2));
        } catch (err) {
            console.error(`ConfigLoader: Failed to save config to ${this.configPath}:`, err);
        }
    }
    
    /**
     * Migrate config from old locations to new .config/daemon.json location
     */
    private migrateConfig(workspaceRoot: string): void {
        const workingDir = path.join(workspaceRoot, '_AiDevLog');
        
        // Check if new config already exists
        if (fs.existsSync(this.configPath)) {
            return;
        }
        
        // Try to migrate from .cache/apc_config.json
        const cacheConfigPath = path.join(workingDir, '.cache', 'apc_config.json');
        if (fs.existsSync(cacheConfigPath)) {
            try {
                const dir = path.dirname(this.configPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                // Copy (don't move) for safety
                const content = fs.readFileSync(cacheConfigPath, 'utf-8');
                fs.writeFileSync(this.configPath, content);
                console.log('ConfigLoader: Migrated config from .cache/ to .config/');
                return;
            } catch (e) {
                console.warn('ConfigLoader: Failed to migrate from .cache/:', e);
            }
        }
        
        // Try to migrate from old .apc_config.json
        const oldConfigPath = path.join(workingDir, '.apc_config.json');
        if (fs.existsSync(oldConfigPath)) {
            try {
                const dir = path.dirname(this.configPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                const content = fs.readFileSync(oldConfigPath, 'utf-8');
                fs.writeFileSync(this.configPath, content);
                console.log('ConfigLoader: Migrated config from old location to .config/');
            } catch (e) {
                console.warn('ConfigLoader: Failed to migrate from old location:', e);
            }
        }
        
        // Also migrate other config files to .config/
        this.migrateOtherConfigs(workingDir);
    }
    
    /**
     * Migrate other config files (roles, workflows, etc.) to .config/
     */
    private migrateOtherConfigs(workingDir: string): void {
        const oldConfigDir = path.join(workingDir, 'Config');
        const newConfigDir = path.join(workingDir, '.config');
        
        if (!fs.existsSync(oldConfigDir)) {
            return;
        }
        
        try {
            // Ensure new config dir exists
            if (!fs.existsSync(newConfigDir)) {
                fs.mkdirSync(newConfigDir, { recursive: true });
            }
            
            // Migrate Roles/ -> roles/
            const oldRolesDir = path.join(oldConfigDir, 'Roles');
            const newRolesDir = path.join(newConfigDir, 'roles');
            if (fs.existsSync(oldRolesDir) && !fs.existsSync(newRolesDir)) {
                fs.cpSync(oldRolesDir, newRolesDir, { recursive: true });
                console.log('ConfigLoader: Migrated Roles/ to .config/roles/');
            }
            
            // Migrate SystemPrompts/ -> system_prompts/
            const oldSystemPromptsDir = path.join(oldConfigDir, 'SystemPrompts');
            const newSystemPromptsDir = path.join(newConfigDir, 'system_prompts');
            if (fs.existsSync(oldSystemPromptsDir) && !fs.existsSync(newSystemPromptsDir)) {
                fs.cpSync(oldSystemPromptsDir, newSystemPromptsDir, { recursive: true });
                console.log('ConfigLoader: Migrated SystemPrompts/ to .config/system_prompts/');
            }
            
            // Migrate workflow_settings.json -> workflows.json
            const oldWorkflowSettings = path.join(oldConfigDir, 'workflow_settings.json');
            const newWorkflowSettings = path.join(newConfigDir, 'workflows.json');
            if (fs.existsSync(oldWorkflowSettings) && !fs.existsSync(newWorkflowSettings)) {
                fs.copyFileSync(oldWorkflowSettings, newWorkflowSettings);
                console.log('ConfigLoader: Migrated workflow_settings.json to .config/workflows.json');
            }
            
            // Migrate context_presets.json
            const oldContextPresets = path.join(oldConfigDir, 'context_presets.json');
            const newContextPresets = path.join(newConfigDir, 'context_presets.json');
            if (fs.existsSync(oldContextPresets) && !fs.existsSync(newContextPresets)) {
                fs.copyFileSync(oldContextPresets, newContextPresets);
                console.log('ConfigLoader: Migrated context_presets.json to .config/');
            }
            
            console.log('ConfigLoader: Config migration to .config/ complete (old files preserved)');
        } catch (e) {
            console.warn('ConfigLoader: Failed to migrate other configs:', e);
        }
    }
}

// ============================================================================
// Workspace Detection
// ============================================================================

/**
 * Find workspace root by looking for markers
 */
export function findWorkspaceRoot(startDir?: string): string {
    let dir = startDir || process.cwd();
    
    while (dir !== path.dirname(dir)) {
        // Check for APC working directory
        if (fs.existsSync(path.join(dir, '_AiDevLog'))) {
            return dir;
        }
        // Check for git repo
        if (fs.existsSync(path.join(dir, '.git'))) {
            return dir;
        }
        // Check for package.json (Node.js project)
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    
    // Fallback to current directory
    return startDir || process.cwd();
}

// ============================================================================
// PID File Management
// ============================================================================

/**
 * Get the daemon PID file path
 */
export function getDaemonPidPath(workspaceRoot: string): string {
    const hash = createWorkspaceHash(workspaceRoot);
    return path.join(require('os').tmpdir(), `apc_daemon_${hash}.pid`);
}

/**
 * Get the daemon port file path (stores actual port if dynamic)
 */
export function getDaemonPortPath(workspaceRoot: string): string {
    const hash = createWorkspaceHash(workspaceRoot);
    return path.join(require('os').tmpdir(), `apc_daemon_${hash}.port`);
}

/**
 * Create a hash of the workspace root for unique identification
 */
export function createWorkspaceHash(workspaceRoot: string): string {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(workspaceRoot).digest('hex').substring(0, 8);
}

/**
 * Check if daemon is running for a workspace
 */
export function isDaemonRunning(workspaceRoot: string): boolean {
    const pidPath = getDaemonPidPath(workspaceRoot);
    
    if (!fs.existsSync(pidPath)) {
        return false;
    }
    
    try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        // Check if process exists
        process.kill(pid, 0);
        return true;
    } catch {
        // Process doesn't exist, clean up stale PID file
        try {
            fs.unlinkSync(pidPath);
        } catch {
            // Ignore cleanup errors
        }
        return false;
    }
}

/**
 * Get the port the daemon is running on
 */
export function getDaemonPort(workspaceRoot: string): number | null {
    const portPath = getDaemonPortPath(workspaceRoot);
    
    if (!fs.existsSync(portPath)) {
        return null;
    }
    
    try {
        return parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
    } catch {
        return null;
    }
}

/**
 * Write daemon PID and port files
 */
export function writeDaemonInfo(workspaceRoot: string, pid: number, port: number): void {
    const pidPath = getDaemonPidPath(workspaceRoot);
    const portPath = getDaemonPortPath(workspaceRoot);
    
    fs.writeFileSync(pidPath, pid.toString());
    fs.writeFileSync(portPath, port.toString());
}

/**
 * Clean up daemon PID and port files
 */
export function cleanupDaemonInfo(workspaceRoot: string): void {
    const pidPath = getDaemonPidPath(workspaceRoot);
    const portPath = getDaemonPortPath(workspaceRoot);
    
    try {
        if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
        if (fs.existsSync(portPath)) fs.unlinkSync(portPath);
    } catch {
        // Ignore cleanup errors
    }
}

