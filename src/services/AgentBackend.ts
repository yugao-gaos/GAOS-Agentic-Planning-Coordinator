/**
 * AgentBackend.ts - Agent Backend Abstraction Layer
 * 
 * Provides a unified interface for running AI agents across different CLI backends.
 * Currently supports Cursor CLI, with the architecture ready for future backends.
 * 
 * Obtain via ServiceLocator:
 *   const agentRunner = ServiceLocator.resolve(AgentRunner);
 *   const result = await agentRunner.run({ id: 'task_1', prompt: '...', cwd: '...' });
 */

import { CursorAgentRunner, AgentRunOptions, AgentRunResult } from './CursorAgentRunner';
import { ServiceLocator } from './ServiceLocator';

// Re-export types for convenience
export { AgentRunOptions, AgentRunResult } from './CursorAgentRunner';

// Re-export AgentInstaller for convenience (no ServiceLocator required)
export { AgentInstaller } from './AgentInstaller';

/**
 * Result of an installation operation
 */
export interface InstallResult {
    success: boolean;
    message: string;
    requiresRestart?: boolean;
}

/**
 * MCP configuration to install
 */
export interface McpInstallConfig {
    name: string;           // e.g., "UnityMCP"
    url?: string;           // For HTTP transport
    command?: string;       // For stdio transport
    args?: string[];
}

/**
 * Interface that all agent backends must implement
 */
export interface IAgentBackend {
    /**
     * Run an agent with the given options
     */
    run(options: AgentRunOptions): Promise<AgentRunResult>;
    
    /**
     * Stop a running agent by ID
     */
    stop(id: string): Promise<boolean>;
    
    /**
     * Check if this backend CLI is available on the system
     */
    isAvailable(): Promise<boolean>;
    
    /**
     * Get list of currently running agent IDs
     */
    getRunningAgents(): string[];
    
    /**
     * Check if a specific agent is running
     */
    isRunning(id: string): boolean;
    
    /**
     * Dispose resources used by this backend
     */
    dispose(): Promise<void>;
    
    /**
     * Install the CLI for this backend (e.g., Cursor CLI)
     * May show instructions or trigger installation
     */
    installCLI(): Promise<InstallResult>;
    
    /**
     * Install/configure an MCP server for this backend
     */
    installMCP(config: McpInstallConfig): Promise<InstallResult>;
    
    /**
     * Get the MCP config file path for this backend
     */
    getMcpConfigPath(): string;
    
    /**
     * Check if a specific MCP is already configured
     */
    isMcpConfigured(name: string): boolean;
    
    /**
     * Remove an MCP configuration
     */
    removeMCP(name: string): Promise<InstallResult>;
    
    /**
     * Kill orphaned agent processes from previous runs
     * Returns the number of processes killed
     */
    killOrphanAgents(): Promise<number>;
}

/**
 * Supported backend types
 */
export type AgentBackendType = 'cursor';

/**
 * AgentRunner - Unified facade for running AI agents
 * 
 * This is the primary interface consumers should use. It delegates to the
 * appropriate backend based on configuration.
 * 
 * Obtain via ServiceLocator:
 *   const runner = ServiceLocator.resolve(AgentRunner);
 * 
 * Example:
 * ```typescript
 * const runner = ServiceLocator.resolve(AgentRunner);
 * 
 * // Check if backend is available
 * if (await runner.isAvailable()) {
 *     const result = await runner.run({
 *         id: 'my-task',
 *         prompt: 'Analyze this code...',
 *         cwd: '/path/to/project',
 *         model: 'sonnet-4.5',
 *         onOutput: (text, type) => console.log(text)
 *     });
 * }
 * ```
 */
export class AgentRunner implements IAgentBackend {
    private backend: IAgentBackend | null = null;
    private backendType: AgentBackendType = 'cursor';
    
    constructor() {
        // Default to cursor backend
        this.initializeBackend('cursor');
    }
    
    /**
     * Set the backend type. Call this before using other methods if you want
     * to use a non-default backend.
     * 
     * @param type The backend type to use
     */
    setBackend(type: AgentBackendType | string): void {
        // Validate backend type - only 'cursor' is currently supported
        if (type !== 'cursor') {
            console.warn(
                `[AgentRunner] Agent backend '${type}' is not yet implemented. Falling back to 'cursor' backend.`
            );
            type = 'cursor';
        }
        
        if (type !== this.backendType) {
            this.backendType = type as AgentBackendType;
            this.initializeBackend(type as AgentBackendType);
        }
    }
    
    /**
     * Get the current backend type
     */
    getBackendType(): AgentBackendType {
        return this.backendType;
    }
    
    /**
     * Initialize the backend based on type
     * Currently only 'cursor' is supported. Future backends (claude-code, etc.)
     * would be added here when implemented.
     */
    private initializeBackend(type: AgentBackendType): void {
        switch (type) {
            case 'cursor':
                this.backend = ServiceLocator.resolve(CursorAgentRunner);
                console.log('[AgentRunner] Backend initialized: cursor');
                break;
            default:
                // Fallback to cursor for any unrecognized type
                console.warn(`[AgentRunner] Unknown backend type: ${type}, falling back to cursor`);
                this.backend = ServiceLocator.resolve(CursorAgentRunner);
                this.backendType = 'cursor';
                break;
        }
    }
    
    /**
     * Ensure backend is initialized
     */
    private ensureBackend(): IAgentBackend {
        if (!this.backend) {
            this.initializeBackend(this.backendType);
        }
        return this.backend!;
    }
    
    // =========================================================================
    // IAgentBackend Implementation
    // =========================================================================
    
    /**
     * Run an agent with the given options
     */
    async run(options: AgentRunOptions): Promise<AgentRunResult> {
        return this.ensureBackend().run(options);
    }
    
    /**
     * Stop a running agent by ID
     */
    async stop(id: string): Promise<boolean> {
        return this.ensureBackend().stop(id);
    }
    
    /**
     * Check if the current backend CLI is available
     */
    async isAvailable(): Promise<boolean> {
        return this.ensureBackend().isAvailable();
    }
    
    /**
     * Get list of currently running agent IDs
     */
    getRunningAgents(): string[] {
        return this.ensureBackend().getRunningAgents();
    }
    
    /**
     * Check if a specific agent is running
     */
    isRunning(id: string): boolean {
        return this.ensureBackend().isRunning(id);
    }
    
    /**
     * Get partial output from a running agent (if available)
     * Returns undefined if the agent is not running or output is not available.
     * 
     * Note: This is currently a stub - full implementation would require
     * tracking output buffers for each running agent.
     */
    getPartialOutput(_id: string): string | undefined {
        // TODO: Implement partial output retrieval for pause/resume functionality
        // This would require CursorAgentRunner to buffer output
        return undefined;
    }
    
    /**
     * Dispose resources
     */
    async dispose(): Promise<void> {
        if (this.backend) {
            await this.backend.dispose();
        }
    }
    
    // =========================================================================
    // Convenience Methods
    // =========================================================================
    
    /**
     * Stop all running agents
     */
    async stopAll(): Promise<void> {
        const backend = this.ensureBackend();
        const runningAgents = backend.getRunningAgents();
        await Promise.all(runningAgents.map(id => backend.stop(id)));
    }
    
    /**
     * Check if any agents are currently running
     */
    hasActiveAgents(): boolean {
        return this.ensureBackend().getRunningAgents().length > 0;
    }
    
    /**
     * Install the CLI for the current backend
     */
    async installCLI(): Promise<InstallResult> {
        return this.ensureBackend().installCLI();
    }
    
    /**
     * Install/configure an MCP server for the current backend
     */
    async installMCP(config: McpInstallConfig): Promise<InstallResult> {
        return this.ensureBackend().installMCP(config);
    }
    
    /**
     * Get the MCP config path for the current backend
     */
    getMcpConfigPath(): string {
        return this.ensureBackend().getMcpConfigPath();
    }
    
    /**
     * Check if a specific MCP is configured
     */
    isMcpConfigured(name: string): boolean {
        return this.ensureBackend().isMcpConfigured(name);
    }
    
    /**
     * Remove an MCP configuration
     */
    async removeMCP(name: string): Promise<InstallResult> {
        return this.ensureBackend().removeMCP(name);
    }
    
    /**
     * Kill orphaned agent processes from previous runs
     */
    async killOrphanAgents(): Promise<number> {
        return this.ensureBackend().killOrphanAgents();
    }
}
