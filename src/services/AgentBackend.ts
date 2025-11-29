/**
 * AgentBackend.ts - Agent Backend Abstraction Layer
 * 
 * Provides a unified interface for running AI agents across different CLI backends.
 * Currently supports Cursor CLI, with the architecture ready for future backends.
 * 
 * Usage:
 *   const agentRunner = AgentRunner.getInstance();
 *   const result = await agentRunner.run({ id: 'task_1', prompt: '...', cwd: '...' });
 */

import * as vscode from 'vscode';
import { CursorAgentRunner, AgentRunOptions, AgentRunResult } from './CursorAgentRunner';

// Re-export types for convenience
export { AgentRunOptions, AgentRunResult } from './CursorAgentRunner';

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
 * Example:
 * ```typescript
 * const runner = AgentRunner.getInstance();
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
    private static instance: AgentRunner;
    private backend: IAgentBackend | null = null;
    private backendType: AgentBackendType = 'cursor';
    
    private constructor() {
        // Default to cursor backend
        this.initializeBackend('cursor');
    }
    
    /**
     * Get the singleton instance
     */
    static getInstance(): AgentRunner {
        if (!AgentRunner.instance) {
            AgentRunner.instance = new AgentRunner();
        }
        return AgentRunner.instance;
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
            vscode.window.showWarningMessage(
                `Agent backend '${type}' is not yet implemented. Falling back to 'cursor' backend.`
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
                this.backend = CursorAgentRunner.getInstance();
                console.log('[AgentRunner] Backend initialized: cursor');
                break;
            default:
                // Fallback to cursor for any unrecognized type
                console.warn(`[AgentRunner] Unknown backend type: ${type}, falling back to cursor`);
                this.backend = CursorAgentRunner.getInstance();
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
}

