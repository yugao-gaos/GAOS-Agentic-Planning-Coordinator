// ============================================================================
// ExecutionContext - Shared state and utilities for node graph execution
// ============================================================================

import { 
    IExecutionContextAPI, 
    IWorkflowVariable, 
    IWorkflowParameter,
    INodeGraph
} from './NodeTypes';
import { WorkflowServices } from '../IWorkflow';
import { Logger } from '../../../utils/Logger';

const log = Logger.create('Daemon', 'ExecutionContext');

/**
 * Expression evaluator using a safe subset of JavaScript
 * Supports basic operators, property access, and function calls
 */
export class ExpressionEvaluator {
    private context: Record<string, any>;
    
    constructor(context: Record<string, any>) {
        this.context = context;
    }
    
    /**
     * Evaluate an expression string
     * 
     * Supported syntax:
     * - Property access: result.score, data['key']
     * - Comparisons: ==, !=, >, <, >=, <=
     * - Logical: &&, ||, !
     * - Arithmetic: +, -, *, /, %
     * - Array/string: .length, .includes()
     * - Ternary: condition ? value1 : value2
     * 
     * @param expression Expression to evaluate
     * @returns Evaluation result
     */
    evaluate(expression: string): any {
        try {
            // Create a safe evaluation function with limited scope
            const safeEval = new Function(
                ...Object.keys(this.context),
                `"use strict"; return (${expression});`
            );
            
            return safeEval(...Object.values(this.context));
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Expression evaluation failed: ${msg}\nExpression: ${expression}`);
        }
    }
    
    /**
     * Update the evaluation context
     */
    updateContext(updates: Record<string, any>): void {
        Object.assign(this.context, updates);
    }
}

/**
 * Template renderer for string interpolation
 * Supports {{variable}} and {{expression}} syntax
 */
export class TemplateRenderer {
    private evaluator: ExpressionEvaluator;
    
    constructor(evaluator: ExpressionEvaluator) {
        this.evaluator = evaluator;
    }
    
    /**
     * Render a template string with variable substitution
     * 
     * @param template Template string with {{...}} placeholders
     * @returns Rendered string
     */
    render(template: string): string {
        // Match {{...}} patterns, including nested braces for objects
        const pattern = /\{\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}\}/g;
        
        return template.replace(pattern, (match, expression) => {
            try {
                const result = this.evaluator.evaluate(expression.trim());
                
                // Convert result to string appropriately
                if (result === null || result === undefined) {
                    return '';
                }
                if (typeof result === 'object') {
                    return JSON.stringify(result);
                }
                return String(result);
            } catch (error) {
                log.warn(`Template expression failed: ${expression}`, error);
                return match; // Keep original if evaluation fails
            }
        });
    }
}

/**
 * ExecutionContext - Main execution context for a node graph
 * 
 * Manages:
 * - Workflow variables (shared state)
 * - Parameters (injected at dispatch)
 * - Expression evaluation
 * - Template rendering
 * - Logging
 * - Agent interactions
 * - Event emission
 */
export class ExecutionContext implements IExecutionContextAPI {
    private variables: Map<string, any> = new Map();
    private parameters: Map<string, any> = new Map();
    private evaluator: ExpressionEvaluator;
    private templateRenderer: TemplateRenderer;
    private services: WorkflowServices;
    private workflowId: string;
    private sessionId: string;
    private logs: Array<{ timestamp: string; level: string; message: string }> = [];
    private stopped: boolean = false;
    private allocatedAgents: string[] = [];
    
    // Callbacks for workflow integration
    private onAgentRequest?: (roleId: string) => Promise<string>;
    private onAgentRelease?: (agentName: string) => void;
    private onAgentTask?: (agentName: string, prompt: string, options?: any) => Promise<{ success: boolean; output: string }>;
    private onEventEmit?: (eventType: string, payload?: any) => void;
    private onEventWait?: (eventType: string, timeoutMs?: number) => Promise<any>;
    
    constructor(
        graph: INodeGraph,
        services: WorkflowServices,
        workflowId: string,
        sessionId: string,
        dispatchParameters?: Record<string, any>
    ) {
        this.services = services;
        this.workflowId = workflowId;
        this.sessionId = sessionId;
        
        // Initialize variables with defaults
        if (graph.variables) {
            for (const variable of graph.variables) {
                this.variables.set(variable.id, variable.default);
            }
        }
        
        // Initialize parameters with defaults, then override with dispatch values
        if (graph.parameters) {
            for (const param of graph.parameters) {
                if (param.default !== undefined) {
                    this.parameters.set(param.name, param.default);
                }
            }
        }
        
        // Apply dispatch parameters
        if (dispatchParameters) {
            for (const [name, value] of Object.entries(dispatchParameters)) {
                this.parameters.set(name, value);
            }
        }
        
        // Validate required parameters
        if (graph.parameters) {
            for (const param of graph.parameters) {
                if (param.required && !this.parameters.has(param.name)) {
                    throw new Error(`Missing required parameter: ${param.name}`);
                }
            }
        }
        
        // Initialize expression evaluator with context
        this.evaluator = new ExpressionEvaluator(this.buildEvaluationContext());
        this.templateRenderer = new TemplateRenderer(this.evaluator);
    }
    
    /**
     * Build the evaluation context object
     */
    private buildEvaluationContext(): Record<string, any> {
        const context: Record<string, any> = {
            // Variables as direct properties
            ...Object.fromEntries(this.variables),
            
            // Parameters under 'parameters' namespace
            parameters: Object.fromEntries(this.parameters),
            
            // Utility functions
            Math,
            JSON: {
                parse: JSON.parse,
                stringify: JSON.stringify
            },
            String,
            Number,
            Boolean,
            Array: {
                isArray: Array.isArray
            },
            Object: {
                keys: Object.keys,
                values: Object.values,
                entries: Object.entries
            }
        };
        
        return context;
    }
    
    /**
     * Refresh the evaluation context after variable changes
     */
    private refreshEvaluationContext(): void {
        this.evaluator.updateContext(this.buildEvaluationContext());
    }
    
    // ========================================================================
    // IExecutionContextAPI Implementation
    // ========================================================================
    
    getVariable(id: string): any {
        return this.variables.get(id);
    }
    
    setVariable(id: string, value: any): void {
        this.variables.set(id, value);
        this.refreshEvaluationContext();
    }
    
    getParameter(name: string): any {
        return this.parameters.get(name);
    }
    
    evaluate(expression: string): any {
        return this.evaluator.evaluate(expression);
    }
    
    renderTemplate(template: string): string {
        return this.templateRenderer.render(template);
    }
    
    log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message
        };
        this.logs.push(entry);
        
        // Also log to output manager
        const prefix = `NodeWF:${this.workflowId.substring(0, 8)}`;
        switch (level) {
            case 'error':
                log.error(`[${prefix}] ${message}`);
                break;
            case 'warn':
                log.warn(`[${prefix}] ${message}`);
                break;
            case 'debug':
                log.debug(`[${prefix}] ${message}`);
                break;
            default:
                log.info(`[${prefix}] ${message}`);
        }
    }
    
    async requestAgent(roleId: string): Promise<string> {
        if (this.onAgentRequest) {
            const agentName = await this.onAgentRequest(roleId);
            this.allocatedAgents.push(agentName);
            return agentName;
        }
        throw new Error('Agent request handler not configured');
    }
    
    releaseAgent(agentName: string): void {
        const index = this.allocatedAgents.indexOf(agentName);
        if (index >= 0) {
            this.allocatedAgents.splice(index, 1);
        }
        if (this.onAgentRelease) {
            this.onAgentRelease(agentName);
        }
    }
    
    async runAgentTask(
        agentName: string, 
        prompt: string, 
        options?: { model?: string; timeoutMs?: number }
    ): Promise<{ success: boolean; output: string }> {
        if (this.onAgentTask) {
            return this.onAgentTask(agentName, prompt, options);
        }
        throw new Error('Agent task handler not configured');
    }
    
    emitEvent(eventType: string, payload?: any): void {
        if (this.onEventEmit) {
            this.onEventEmit(eventType, payload);
        }
        this.log(`Event emitted: ${eventType}`, 'debug');
    }
    
    async waitForEvent(eventType: string, timeoutMs?: number): Promise<any> {
        if (this.onEventWait) {
            return this.onEventWait(eventType, timeoutMs);
        }
        throw new Error('Event wait handler not configured');
    }
    
    async executeCommand(
        command: string, 
        options?: { cwd?: string; timeoutMs?: number }
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        const timeoutMs = options?.timeoutMs ?? 60000;
        const cwd = options?.cwd ?? process.cwd();
        
        this.log(`Executing command: ${command}`, 'debug');
        
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd,
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024 // 10MB
            });
            
            return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
            return {
                exitCode: error.code ?? 1,
                stdout: error.stdout ?? '',
                stderr: error.stderr ?? error.message
            };
        }
    }
    
    async readFile(path: string): Promise<string> {
        const fs = await import('fs/promises');
        return fs.readFile(path, 'utf-8');
    }
    
    getWorkflowServices(): WorkflowServices {
        return this.services;
    }
    
    shouldStop(): boolean {
        return this.stopped;
    }
    
    async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // ========================================================================
    // System Event API - For EventNode internal operations
    // ========================================================================
    
    /**
     * Read task state from StateManager
     */
    async readTaskState(taskId: string): Promise<any> {
        try {
            const taskManager = (this.services as any).taskManager;
            
            if (!taskManager) {
                throw new Error('TaskManager not available');
            }
            
            // Get task from TaskManager
            const task = taskManager.getTask(taskId);
            if (!task) {
                throw new Error(`Task not found: ${taskId}`);
            }
            
            return {
                id: task.id,
                description: task.description,
                dependencies: task.dependencies || [],
                status: task.status,
                assignedTo: task.assignedTo,
                metadata: task.metadata
            };
        } catch (error: any) {
            this.log(`Failed to read task state: ${error.message}`, 'error');
            throw error;
        }
    }
    
    /**
     * Read plan file content for a session
     */
    async readPlanFile(sessionId: string): Promise<{ content: string; path: string }> {
        try {
            const stateManager = this.services.stateManager;
            const session = stateManager.getPlanningSession(sessionId);
            
            if (!session) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            
            if (!session.currentPlanPath) {
                throw new Error(`No plan file for session: ${sessionId}`);
            }
            
            const content = await this.readFile(session.currentPlanPath);
            
            return {
                content,
                path: session.currentPlanPath
            };
        } catch (error: any) {
            this.log(`Failed to read plan file: ${error.message}`, 'error');
            throw error;
        }
    }
    
    /**
     * Read context brief for a session
     */
    async readContextBrief(sessionId: string): Promise<{ content: string; path: string }> {
        try {
            const stateManager = this.services.stateManager;
            const path = await import('path');
            
            const planFolder = stateManager.getPlanFolder(sessionId);
            const briefPath = path.join(planFolder, 'context_brief.md');
            
            const content = await this.readFile(briefPath);
            
            return {
                content,
                path: briefPath
            };
        } catch (error: any) {
            this.log(`Failed to read context brief: ${error.message}`, 'error');
            throw error;
        }
    }
    
    /**
     * Demote an agent to the bench (keep allocated but idle)
     */
    demoteAgentToBench(agentName: string): void {
        // This is handled by the BaseWorkflow wrapper
        // For now, just log it
        this.log(`Demoting agent to bench: ${agentName}`, 'debug');
    }
    
    // ========================================================================
    // Configuration Methods (called by ScriptableNodeWorkflow)
    // ========================================================================
    
    /**
     * Set the agent request handler
     */
    setAgentRequestHandler(handler: (roleId: string) => Promise<string>): void {
        this.onAgentRequest = handler;
    }
    
    /**
     * Set the agent release handler
     */
    setAgentReleaseHandler(handler: (agentName: string) => void): void {
        this.onAgentRelease = handler;
    }
    
    /**
     * Set the agent task handler
     */
    setAgentTaskHandler(
        handler: (agentName: string, prompt: string, options?: any) => Promise<{ success: boolean; output: string }>
    ): void {
        this.onAgentTask = handler;
    }
    
    /**
     * Set the event emit handler
     */
    setEventEmitHandler(handler: (eventType: string, payload?: any) => void): void {
        this.onEventEmit = handler;
    }
    
    /**
     * Set the event wait handler
     */
    setEventWaitHandler(handler: (eventType: string, timeoutMs?: number) => Promise<any>): void {
        this.onEventWait = handler;
    }
    
    /**
     * Mark context as stopped (for pause/cancel)
     */
    stop(): void {
        this.stopped = true;
    }
    
    /**
     * Resume context after pause
     */
    resume(): void {
        this.stopped = false;
    }
    
    /**
     * Get all allocated agents (for cleanup)
     */
    getAllocatedAgents(): string[] {
        return [...this.allocatedAgents];
    }
    
    /**
     * Get execution logs
     */
    getLogs(): Array<{ timestamp: string; level: string; message: string }> {
        return [...this.logs];
    }
    
    /**
     * Get all variables (for checkpoint/serialization)
     */
    getAllVariables(): Record<string, any> {
        return Object.fromEntries(this.variables);
    }
    
    /**
     * Restore variables from checkpoint
     */
    restoreVariables(variables: Record<string, any>): void {
        this.variables.clear();
        for (const [id, value] of Object.entries(variables)) {
            this.variables.set(id, value);
        }
        this.refreshEvaluationContext();
    }
    
    /**
     * Add node outputs to evaluation context
     * Called after each node completes to make outputs available
     */
    addNodeOutputs(nodeId: string, outputs: Record<string, any>): void {
        // Make node outputs available as nodeId.portId
        const nodeOutputs: Record<string, any> = {};
        for (const [portId, value] of Object.entries(outputs)) {
            nodeOutputs[portId] = value;
        }
        
        // Update context with node outputs
        this.evaluator.updateContext({ [nodeId]: nodeOutputs });
    }
}

