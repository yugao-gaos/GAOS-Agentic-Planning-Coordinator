/**
 * DaemonConfig.ts - Configuration loader for APC daemon
 * 
 * This module provides configuration loading without vscode dependencies.
 * Configuration can come from:
 * 1. Config file (_AiDevLog/.apc_config.json)
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
    
    /** Whether to use iterative planning loop */
    useIterativePlanning: boolean;
    
    /** State update interval in milliseconds */
    stateUpdateInterval: number;
    
    /** Path to Unity best practices document */
    unityBestPracticesPath: string;
    
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
    agentPoolSize: 5,
    defaultBackend: 'cursor',
    useIterativePlanning: true,
    stateUpdateInterval: 5000,
    unityBestPracticesPath: '',
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
    
    constructor(workspaceRoot: string) {
        // Config now stored in .cache/ folder
        this.configPath = path.join(workspaceRoot, '_AiDevLog', '.cache', 'apc_config.json');
        // Migrate from old location if needed
        this.migrateOldConfig(workspaceRoot);
        this.config = this.loadConfig(workspaceRoot);
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
     * Update configuration (persists to file)
     */
    set<K extends keyof CoreConfig>(key: K, value: CoreConfig[K]): void {
        this.config[key] = value;
        this.saveConfig();
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
        
        if (typeof raw.useIterativePlanning === 'boolean') {
            sanitized.useIterativePlanning = raw.useIterativePlanning;
        }
        
        if (typeof raw.stateUpdateInterval === 'number' && raw.stateUpdateInterval >= 1000) {
            sanitized.stateUpdateInterval = raw.stateUpdateInterval;
        }
        
        if (typeof raw.unityBestPracticesPath === 'string') {
            sanitized.unityBestPracticesPath = raw.unityBestPracticesPath;
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
        
        // APC_ITERATIVE_PLANNING
        if (process.env.APC_ITERATIVE_PLANNING !== undefined) {
            config.useIterativePlanning = process.env.APC_ITERATIVE_PLANNING === 'true';
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
    }
    
    /**
     * Save configuration to file
     */
    private saveConfig(): void {
        // Ensure .cache directory exists
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
    }
    
    /**
     * Migrate old config location to new .cache/ location
     */
    private migrateOldConfig(workspaceRoot: string): void {
        const oldPath = path.join(workspaceRoot, '_AiDevLog', '.apc_config.json');
        if (fs.existsSync(oldPath) && !fs.existsSync(this.configPath)) {
            try {
                const dir = path.dirname(this.configPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.renameSync(oldPath, this.configPath);
                console.log('ConfigLoader: Migrated config to .cache/');
            } catch (e) {
                console.warn('ConfigLoader: Failed to migrate old config:', e);
            }
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

