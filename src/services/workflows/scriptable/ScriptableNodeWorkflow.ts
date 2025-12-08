// ============================================================================
// ScriptableNodeWorkflow - Workflow implementation using node graphs
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from '../BaseWorkflow';
import { WorkflowServices } from '../IWorkflow';
import { 
    WorkflowConfig, 
    WorkflowResult 
} from '../../../types/workflow';
import { INodeGraph, IDebugOptions } from './NodeTypes';
import { ExecutionContext } from './ExecutionContext';
import { NodeExecutionEngine, DebugEventCallback } from './NodeExecutionEngine';
import { NodeGraphLoader } from './NodeGraphLoader';
import { registerBuiltinNodes, areBuiltinNodesRegistered } from './nodes';
import { Logger } from '../../../utils/Logger';

const log = Logger.create('Daemon', 'ScriptableNodeWorkflow');

/**
 * Input for ScriptableNodeWorkflow
 */
export interface ScriptableNodeWorkflowInput {
    /** Path to the YAML graph file (relative to _AiDevLog/Workflows or absolute) */
    graphPath?: string;
    
    /** Inline graph definition (alternative to graphPath) */
    graph?: INodeGraph;
    
    /** Parameters to pass to the workflow */
    parameters?: Record<string, any>;
    
    /** Enable debug mode */
    debug?: boolean;
    
    /** Debug options */
    debugOptions?: IDebugOptions;
    
    /** Workflow input data (passed to start node) */
    workflowInput?: any;
}

/**
 * ScriptableNodeWorkflow - Executes node graph definitions
 * 
 * This workflow type allows users to design custom workflows using a visual
 * node editor. At runtime, the node graph is loaded from YAML and executed
 * by the NodeExecutionEngine.
 * 
 * Features:
 * - Load graph from YAML file or inline definition
 * - Execute nodes with full BaseWorkflow integration (agent pool, events, etc.)
 * - Support for all built-in node types
 * - Per-node error handling and timeouts
 * - Checkpointing for crash recovery
 * - Debug mode with step-through
 */
export class ScriptableNodeWorkflow extends BaseWorkflow {
    private graph: INodeGraph | null = null;
    private graphPath?: string;
    private executionContext: ExecutionContext | null = null;
    private engine: NodeExecutionEngine | null = null;
    private graphLoader: NodeGraphLoader;
    private debugMode: boolean = false;
    private debugOptions?: IDebugOptions;
    private debugCallback?: DebugEventCallback;
    private workflowInputData?: any;
    
    /** Workflow doesn't inherently require Unity */
    static readonly requiresUnity = false;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Ensure built-in nodes are registered
        if (!areBuiltinNodesRegistered()) {
            registerBuiltinNodes();
        }
        
        this.graphLoader = new NodeGraphLoader();
        
        // Extract input
        const input = config.input as ScriptableNodeWorkflowInput;
        this.graphPath = input.graphPath;
        this.graph = input.graph || null;
        this.debugMode = input.debug || false;
        this.debugOptions = input.debugOptions;
        this.workflowInputData = input.workflowInput;
        
        // Store parameters in input for the execution context
        if (input.parameters) {
            this.input.parameters = input.parameters;
        }
    }
    
    /**
     * Set debug callback for step-through debugging
     */
    setDebugCallback(callback: DebugEventCallback): void {
        this.debugCallback = callback;
    }
    
    // ========================================================================
    // BaseWorkflow Implementation
    // ========================================================================
    
    getPhases(): string[] {
        // Node workflow uses dynamic execution, but we report phases for progress
        return ['load', 'execute', 'finalize'];
    }
    
    protected getProgressMessage(): string {
        if (!this.graph) {
            return 'Loading graph...';
        }
        return `Executing: ${this.graph.name}`;
    }
    
    protected getOutput(): any {
        if (this.engine) {
            const state = this.engine.getExecutionState();
            // Find end node outputs
            for (const [nodeId, nodeState] of state) {
                const node = this.graph?.nodes.find(n => n.id === nodeId);
                if (node?.type === 'end' && nodeState.outputs['__workflow_output__']) {
                    return nodeState.outputs['__workflow_output__'];
                }
            }
        }
        return null;
    }
    
    getState(): object {
        return {
            graphPath: this.graphPath,
            graphName: this.graph?.name,
            phaseIndex: this.phaseIndex,
            executionState: this.engine ? 
                Object.fromEntries(this.engine.getExecutionState()) : 
                null
        };
    }
    
    /**
     * Override task occupancy - scriptable workflows occupy tasks based on parameters
     */
    getOccupiedTaskIds(): string[] {
        // If the workflow has a taskId parameter, use it
        const taskId = this.input.parameters?.taskId;
        if (taskId) {
            return [taskId];
        }
        return [];
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'load':
                await this.loadGraph();
                break;
            case 'execute':
                await this.executeGraph();
                break;
            case 'finalize':
                await this.finalizeExecution();
                break;
        }
    }
    
    // ========================================================================
    // Graph Execution
    // ========================================================================
    
    /**
     * Phase 1: Load the node graph
     */
    private async loadGraph(): Promise<void> {
        this.log('Loading node graph...');
        
        if (!this.graph && !this.graphPath) {
            throw new Error('Either graphPath or graph must be provided');
        }
        
        if (!this.graph && this.graphPath) {
            this.graph = await this.graphLoader.load(this.graphPath);
        }
        
        this.log(`Loaded graph: ${this.graph!.name} (${this.graph!.nodes.length} nodes)`);
        
        // Initialize execution context
        this.executionContext = new ExecutionContext(
            this.graph!,
            {
                stateManager: this.stateManager,
                agentPoolService: this.agentPoolService,
                roleRegistry: this.roleRegistry,
                unityManager: this.unityManager,
                outputManager: this.outputManager,
                unityEnabled: this.unityEnabled
            },
            this.id,
            this.sessionId,
            this.input.parameters
        );
        
        // Wire up context handlers
        this.setupContextHandlers();
    }
    
    /**
     * Set up handlers for ExecutionContext callbacks
     */
    private setupContextHandlers(): void {
        if (!this.executionContext) return;
        
        // Agent request handler - uses BaseWorkflow's requestAgent
        this.executionContext.setAgentRequestHandler(async (roleId: string) => {
            return this.requestAgent(roleId);
        });
        
        // Agent release handler - uses BaseWorkflow's releaseAgent
        this.executionContext.setAgentReleaseHandler((agentName: string) => {
            this.releaseAgent(agentName);
        });
        
        // Agent task handler - run agent with prompt
        this.executionContext.setAgentTaskHandler(async (
            agentName: string,
            prompt: string,
            options?: { model?: string; timeoutMs?: number }
        ) => {
            return this.runAgentWithPrompt(agentName, prompt, options);
        });
        
        // Event emit handler
        this.executionContext.setEventEmitHandler((eventType: string, payload?: any) => {
            this.emitWorkflowEvent(eventType, payload);
        });
        
        // Event wait handler
        this.executionContext.setEventWaitHandler(async (eventType: string, timeoutMs?: number) => {
            return this.waitForWorkflowEvent(eventType, timeoutMs);
        });
    }
    
    /**
     * Run an agent task with CLI callback requirement
     */
    private async runAgentWithPrompt(
        agentName: string,
        prompt: string,
        options?: { model?: string; timeoutMs?: number; stage?: 'implementation' | 'review' | 'analysis' | 'context' | 'planning' | 'finalization' }
    ): Promise<{ success: boolean; output: string; fromCallback?: boolean }> {
        const stage = options?.stage || 'implementation';
        const timeoutMs = options?.timeoutMs || 600000;
        const model = options?.model || 'claude-sonnet-4-20250514';
        
        try {
            // Use CLI callback for structured completion
            const result = await this.runAgentTaskWithCallback(
                `scriptable_${agentName}`,
                prompt,
                'engineer',  // Default to engineer role for scriptable workflows
                {
                    expectedStage: stage,
                    timeout: timeoutMs,
                    model,
                    cwd: process.cwd(),
                    agentName
                }
            );
            
            if (result.fromCallback && this.isAgentSuccess(result)) {
                return {
                    success: true,
                    output: result.payload?.message || '',
                    fromCallback: true
                };
            } else if (!result.fromCallback) {
                throw new Error(
                    'Agent did not use CLI callback (`apc agent complete`). ' +
                    'All agents must report results via CLI callback.'
                );
            } else {
                return {
                    success: false,
                    output: result.payload?.error || 'Agent task failed',
                    fromCallback: true
                };
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                output: errorMsg,
                fromCallback: false
            };
        }
    }
    
    /**
     * Emit a workflow event
     */
    private emitWorkflowEvent(eventType: string, payload?: any): void {
        this.log(`Emitting event: ${eventType}`);
        // Events are handled by the coordinator/daemon
        this.onProgress.fire({
            ...this.getProgress(),
            message: `Event: ${eventType}`
        });
    }
    
    /**
     * Wait for a workflow event
     */
    private async waitForWorkflowEvent(eventType: string, timeoutMs?: number): Promise<any> {
        this.log(`Waiting for event: ${eventType}`);
        
        // Simple implementation - wait for timeout or event
        // In practice, this would be wired to the event system
        const timeout = timeoutMs || 60000;
        
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timeout waiting for event: ${eventType}`));
            }, timeout);
            
            // For now, resolve immediately - proper implementation would
            // subscribe to event system
            clearTimeout(timer);
            resolve({});
        });
    }
    
    /**
     * Phase 2: Execute the node graph
     */
    private async executeGraph(): Promise<void> {
        if (!this.graph || !this.executionContext) {
            throw new Error('Graph not loaded');
        }
        
        this.log(`Executing graph: ${this.graph.name}`);
        
        // Set up checkpoint path
        const checkpointPath = this.getCheckpointPath();
        
        // Create engine
        this.engine = new NodeExecutionEngine(
            this.graph,
            this.executionContext,
            {
                checkpointPath,
                debugOptions: this.debugMode ? (this.debugOptions || { stepThrough: false, logPortValues: true, mockAgents: false }) : undefined,
                debugCallback: this.debugCallback
            }
        );
        
        // Check for existing checkpoint
        if (fs.existsSync(checkpointPath)) {
            this.log('Restoring from checkpoint...');
            await this.engine.restoreFromCheckpoint(checkpointPath);
        }
        
        // Execute
        const result = await this.engine.execute(this.workflowInputData);
        
        if (!result.success) {
            throw new Error(result.error || 'Graph execution failed');
        }
        
        this.log(`Graph execution completed (${result.durationMs}ms)`);
    }
    
    /**
     * Phase 3: Finalize execution
     */
    private async finalizeExecution(): Promise<void> {
        this.log('Finalizing execution...');
        
        // Release all agents from context
        if (this.executionContext) {
            const allocatedAgents = this.executionContext.getAllocatedAgents();
            for (const agentName of allocatedAgents) {
                this.releaseAgent(agentName);
            }
        }
        
        // Clean up checkpoint file
        const checkpointPath = this.getCheckpointPath();
        if (fs.existsSync(checkpointPath)) {
            try {
                fs.unlinkSync(checkpointPath);
            } catch {
                // Ignore cleanup errors
            }
        }
        
        this.log('Execution finalized');
    }
    
    /**
     * Get checkpoint file path
     */
    private getCheckpointPath(): string {
        const planFolder = this.stateManager.getPlanFolder(this.sessionId);
        const checkpointDir = path.join(planFolder, 'checkpoints');
        
        if (!fs.existsSync(checkpointDir)) {
            fs.mkdirSync(checkpointDir, { recursive: true });
        }
        
        return path.join(checkpointDir, `${this.id}.checkpoint.json`);
    }
    
    // ========================================================================
    // Lifecycle Overrides
    // ========================================================================
    
    /**
     * Override pause to pause the engine
     */
    async pause(options?: { force?: boolean }): Promise<void> {
        if (this.engine) {
            this.engine.pause();
        }
        if (this.executionContext) {
            this.executionContext.stop();
        }
        await super.pause(options);
    }
    
    /**
     * Override resume to resume the engine
     */
    async resume(): Promise<void> {
        if (this.engine) {
            this.engine.resume();
        }
        if (this.executionContext) {
            this.executionContext.resume();
        }
        await super.resume();
    }
    
    /**
     * Override cancel to cancel the engine
     */
    async cancel(): Promise<void> {
        if (this.engine) {
            this.engine.cancel();
        }
        if (this.executionContext) {
            this.executionContext.stop();
        }
        await super.cancel();
    }
    
    /**
     * Override dispose to clean up resources
     */
    dispose(): void {
        this.engine = null;
        this.executionContext = null;
        this.graph = null;
        super.dispose();
    }
    
    // ========================================================================
    // Debug Mode Controls
    // ========================================================================
    
    /**
     * Step to next node (debug mode)
     */
    step(): void {
        if (this.engine && this.debugMode) {
            this.engine.step();
        }
    }
    
    /**
     * Get current execution state (for UI)
     */
    getExecutionState(): Map<string, any> | null {
        return this.engine?.getExecutionState() || null;
    }
    
    /**
     * Get the loaded graph (for UI)
     */
    getGraph(): INodeGraph | null {
        return this.graph;
    }
}

