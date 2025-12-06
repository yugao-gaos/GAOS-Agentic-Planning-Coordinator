// ============================================================================
// NodeExecutionEngine - Graph interpreter with parallel execution support
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { 
    INodeGraph, 
    INodeInstance, 
    INodeConnection,
    INodeExecutionResult,
    IExecutionCheckpoint,
    IDebugOptions,
    NodeExecutionStatus,
    IExecutionContextAPI
} from './NodeTypes';
import { ExecutionContext } from './ExecutionContext';
import { nodeRegistry } from './NodeRegistry';
import { NodeGraphLoader } from './NodeGraphLoader';
import { Logger } from '../../../utils/Logger';

const log = Logger.create('Daemon', 'NodeExecutionEngine');

/**
 * Execution state for a node
 */
interface NodeState {
    status: NodeExecutionStatus;
    inputs: Record<string, any>;
    outputs: Record<string, any>;
    result?: INodeExecutionResult;
    retryCount: number;
    startedAt?: string;
    error?: string;  // Error message when status is 'failed' or 'skipped'
}

/**
 * Parallel branch state
 */
interface BranchState {
    branchId: string;
    nodeIds: string[];
    status: 'pending' | 'running' | 'completed' | 'failed';
    result?: any;
}

/**
 * Loop state for for/while nodes
 */
interface LoopState {
    nodeId: string;
    type: 'for' | 'while';
    currentIndex: number;
    items?: any[];
    maxIterations?: number;
    results: any[];
    bodyNodeIds: string[];
}

/**
 * Engine execution result
 */
export interface EngineExecutionResult {
    success: boolean;
    output: any;
    error?: string;
    nodeResults: Map<string, INodeExecutionResult>;
    durationMs: number;
}

/**
 * Debug event types
 */
export type DebugEventType = 
    | 'node_start'
    | 'node_complete'
    | 'node_error'
    | 'breakpoint'
    | 'step'
    | 'port_value';

/**
 * Debug event callback
 */
export type DebugEventCallback = (
    eventType: DebugEventType,
    nodeId: string,
    data?: any
) => void;

/**
 * NodeExecutionEngine - Executes node graphs with support for:
 * - Sequential and parallel execution
 * - Control flow (if/switch/for/while)
 * - Checkpoints for crash recovery
 * - Debug mode with step-through
 * - Per-node error handling
 */
export class NodeExecutionEngine {
    private graph: INodeGraph;
    private context: ExecutionContext;
    private nodeStates: Map<string, NodeState> = new Map();
    private branchStates: Map<string, BranchState> = new Map();
    private loopStates: Map<string, LoopState> = new Map();
    private checkpointPath?: string;
    private debugOptions?: IDebugOptions;
    private debugCallback?: DebugEventCallback;
    private isPaused: boolean = false;
    private isCancelled: boolean = false;
    private stepResolve?: () => void;
    private graphLoader: NodeGraphLoader;
    
    constructor(
        graph: INodeGraph,
        context: ExecutionContext,
        options?: {
            checkpointPath?: string;
            debugOptions?: IDebugOptions;
            debugCallback?: DebugEventCallback;
        }
    ) {
        this.graph = graph;
        this.context = context;
        this.checkpointPath = options?.checkpointPath;
        this.debugOptions = options?.debugOptions;
        this.debugCallback = options?.debugCallback;
        this.graphLoader = new NodeGraphLoader();
        
        // Initialize node states
        for (const node of graph.nodes) {
            this.nodeStates.set(node.id, {
                status: 'pending',
                inputs: {},
                outputs: {},
                retryCount: 0
            });
        }
    }
    
    /**
     * Execute the entire graph
     */
    async execute(workflowInput?: any): Promise<EngineExecutionResult> {
        const startTime = Date.now();
        
        log.info(`Starting execution of graph: ${this.graph.name}`);
        
        try {
            // Find start node
            const startNode = this.graph.nodes.find(n => n.type === 'start');
            if (!startNode) {
                throw new Error('Graph has no start node');
            }
            
            // Inject workflow input
            const startState = this.nodeStates.get(startNode.id)!;
            startState.inputs['__workflow_input__'] = workflowInput;
            
            // Execute from start node
            await this.executeNode(startNode.id);
            
            // Collect output from end nodes
            const endNodes = this.graph.nodes.filter(n => n.type === 'end');
            let output: any = {};
            
            for (const endNode of endNodes) {
                const state = this.nodeStates.get(endNode.id);
                if (state?.status === 'completed' && state.outputs['__workflow_output__']) {
                    output = { ...output, ...state.outputs['__workflow_output__'] };
                }
            }
            
            // Build result map
            const nodeResults = new Map<string, INodeExecutionResult>();
            for (const [nodeId, state] of this.nodeStates) {
                if (state.result) {
                    nodeResults.set(nodeId, state.result);
                }
            }
            
            return {
                success: true,
                output,
                nodeResults,
                durationMs: Date.now() - startTime
            };
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error(`Graph execution failed: ${errorMsg}`);
            
            // Build partial result map
            const nodeResults = new Map<string, INodeExecutionResult>();
            for (const [nodeId, state] of this.nodeStates) {
                if (state.result) {
                    nodeResults.set(nodeId, state.result);
                }
            }
            
            return {
                success: false,
                output: null,
                error: errorMsg,
                nodeResults,
                durationMs: Date.now() - startTime
            };
        }
    }
    
    /**
     * Execute a single node and its downstream connections
     */
    private async executeNode(nodeId: string): Promise<void> {
        if (this.isCancelled) {
            throw new Error('Execution cancelled');
        }
        
        const node = this.graph.nodes.find(n => n.id === nodeId);
        if (!node) {
            throw new Error(`Node not found: ${nodeId}`);
        }
        
        const state = this.nodeStates.get(nodeId)!;
        
        // Skip if already completed
        if (state.status === 'completed' || state.status === 'skipped') {
            return;
        }
        
        // Handle pause/step mode
        if (this.isPaused || this.debugOptions?.stepThrough) {
            await this.waitForStep(nodeId);
        }
        
        // Check breakpoints
        if (this.debugOptions?.breakpoints?.includes(nodeId)) {
            this.debugCallback?.('breakpoint', nodeId);
            await this.waitForStep(nodeId);
        }
        
        // Mark as running
        state.status = 'running';
        state.startedAt = new Date().toISOString();
        this.debugCallback?.('node_start', nodeId);
        
        const startTime = Date.now();
        
        try {
            // Gather inputs from connections
            await this.gatherInputs(node);
            
            // Log port values in debug mode
            if (this.debugOptions?.logPortValues) {
                this.debugCallback?.('port_value', nodeId, { inputs: state.inputs });
            }
            
            // Execute node
            const executor = nodeRegistry.getExecutor(node.type);
            if (!executor) {
                throw new Error(`No executor for node type: ${node.type}`);
            }
            
            // Apply timeout if configured
            const timeoutMs = node.timeoutMs || 300000; // 5 min default
            const outputs = await this.executeWithTimeout(
                () => executor(node, state.inputs, this.context),
                timeoutMs
            );
            
            state.outputs = outputs;
            state.status = 'completed';
            
            // Add outputs to context for expression evaluation
            this.context.addNodeOutputs(nodeId, outputs);
            
            // Log output values in debug mode
            if (this.debugOptions?.logPortValues) {
                this.debugCallback?.('port_value', nodeId, { outputs });
            }
            
            // Build result
            state.result = {
                nodeId,
                status: 'completed',
                outputs,
                durationMs: Date.now() - startTime,
                startedAt: state.startedAt,
                endedAt: new Date().toISOString()
            };
            
            this.debugCallback?.('node_complete', nodeId, state.result);
            
            // Save checkpoint if configured
            if (node.checkpoint) {
                await this.saveCheckpoint();
            }
            
            // Handle special node outputs
            await this.handleSpecialOutputs(node, outputs);
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            // Handle error based on node config
            const handled = await this.handleNodeError(node, error, state);
            
            if (!handled) {
                state.status = 'failed';
                state.result = {
                    nodeId,
                    status: 'failed',
                    outputs: {},
                    error: errorMsg,
                    durationMs: Date.now() - startTime,
                    startedAt: state.startedAt!,
                    endedAt: new Date().toISOString()
                };
                
                this.debugCallback?.('node_error', nodeId, { error: errorMsg });
                throw error;
            }
        }
    }
    
    /**
     * Gather inputs for a node from connected outputs
     */
    private async gatherInputs(node: INodeInstance): Promise<void> {
        const state = this.nodeStates.get(node.id)!;
        
        // Find all connections to this node
        const incomingConnections = this.graph.connections.filter(
            c => c.toNodeId === node.id
        );
        
        for (const conn of incomingConnections) {
            const sourceState = this.nodeStates.get(conn.fromNodeId);
            
            if (sourceState?.status !== 'completed') {
                // Source not ready - this shouldn't happen in normal execution
                continue;
            }
            
            // Get output value from source
            const value = sourceState.outputs[conn.fromPortId];
            state.inputs[conn.toPortId] = value;
        }
    }
    
    /**
     * Handle special node outputs (branching, loops, parallel, subgraph)
     */
    private async handleSpecialOutputs(
        node: INodeInstance, 
        outputs: Record<string, any>
    ): Promise<void> {
        // Handle branching (if/switch)
        if (outputs.__branch__) {
            await this.handleBranching(node, outputs.__branch__);
            return;
        }
        
        // Handle parallel branching
        if (outputs.__parallel__) {
            await this.handleParallelBranch(node, outputs.__parallel__);
            return;
        }
        
        // Handle sync
        if (outputs.__sync__) {
            await this.handleSync(node, outputs.__sync__);
            return;
        }
        
        // Handle loops
        if (outputs.__loop__) {
            await this.handleLoop(node, outputs.__loop__);
            return;
        }
        
        // Handle subgraph
        if (outputs.__subgraph__) {
            await this.handleSubgraph(node, outputs.__subgraph__);
            return;
        }
        
        // Normal flow - execute downstream nodes
        await this.executeDownstream(node.id);
    }
    
    /**
     * Execute downstream nodes connected to the given node
     */
    private async executeDownstream(nodeId: string): Promise<void> {
        const outgoingConnections = this.graph.connections.filter(
            c => c.fromNodeId === nodeId
        );
        
        // Group by target node
        const targetNodes = new Set(outgoingConnections.map(c => c.toNodeId));
        
        // Execute each target node
        for (const targetId of targetNodes) {
            // Check if all required inputs are ready
            const targetNode = this.graph.nodes.find(n => n.id === targetId);
            if (targetNode && this.areInputsReady(targetNode)) {
                await this.executeNode(targetId);
            }
        }
    }
    
    /**
     * Check if all required inputs for a node are ready
     */
    private areInputsReady(node: INodeInstance): boolean {
        const incomingConnections = this.graph.connections.filter(
            c => c.toNodeId === node.id
        );
        
        // Check if all source nodes have completed
        for (const conn of incomingConnections) {
            const sourceState = this.nodeStates.get(conn.fromNodeId);
            if (!sourceState || sourceState.status !== 'completed') {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Handle conditional branching (if/switch)
     */
    private async handleBranching(
        node: INodeInstance, 
        branchPort: string
    ): Promise<void> {
        // Find connections from the selected branch port
        const branchConnections = this.graph.connections.filter(
            c => c.fromNodeId === node.id && c.fromPortId === branchPort
        );
        
        // Execute branch targets
        for (const conn of branchConnections) {
            await this.executeNode(conn.toNodeId);
        }
    }
    
    /**
     * Handle parallel branching
     */
    private async handleParallelBranch(
        node: INodeInstance,
        parallelConfig: { type: string; branchCount: number; branches: string[] }
    ): Promise<void> {
        log.debug(`Starting parallel execution with ${parallelConfig.branchCount} branches`);
        
        // Create branch states
        const branchPromises: Promise<void>[] = [];
        
        for (const branchPort of parallelConfig.branches) {
            const branchConnections = this.graph.connections.filter(
                c => c.fromNodeId === node.id && c.fromPortId === branchPort
            );
            
            // Execute each branch in parallel
            for (const conn of branchConnections) {
                branchPromises.push(this.executeNode(conn.toNodeId));
            }
        }
        
        // Wait for all branches
        await Promise.all(branchPromises);
    }
    
    /**
     * Handle sync node (wait for branches)
     */
    private async handleSync(
        node: INodeInstance,
        syncConfig: { 
            type: string; 
            mode: string; 
            inputCount: number;
            canProceed: boolean;
        }
    ): Promise<void> {
        if (syncConfig.canProceed) {
            // All required inputs received, continue execution
            await this.executeDownstream(node.id);
        }
        // If not ready, the node will be re-evaluated when more inputs arrive
    }
    
    /**
     * Handle loop execution (for/while)
     */
    private async handleLoop(
        node: INodeInstance,
        loopConfig: {
            type: 'for' | 'while';
            items?: any[];
            condition?: string;
            maxIterations?: number;
            currentIndex: number;
        }
    ): Promise<void> {
        // Find loop body connections (from 'loop' port)
        const loopBodyConnections = this.graph.connections.filter(
            c => c.fromNodeId === node.id && c.fromPortId === 'loop'
        );
        
        // Find complete connections (from 'complete' port)
        const completeConnections = this.graph.connections.filter(
            c => c.fromNodeId === node.id && c.fromPortId === 'complete'
        );
        
        if (loopConfig.type === 'for' && loopConfig.items) {
            // For loop - iterate over items
            const results: any[] = [];
            
            for (let i = 0; i < loopConfig.items.length; i++) {
                if (this.isCancelled) break;
                
                // Update node outputs with current item/index
                const state = this.nodeStates.get(node.id)!;
                state.outputs.item = loopConfig.items[i];
                state.outputs.index = i;
                this.context.addNodeOutputs(node.id, state.outputs);
                
                // Execute loop body
                for (const conn of loopBodyConnections) {
                    // Reset downstream node states for re-execution
                    this.resetNodeState(conn.toNodeId);
                    await this.executeNode(conn.toNodeId);
                }
                
                // Collect results from last node in body
                // (simplified - in practice would track loop body output)
            }
            
            // Update outputs with results
            const state = this.nodeStates.get(node.id)!;
            state.outputs.results = results;
            
        } else if (loopConfig.type === 'while' && loopConfig.condition) {
            // While loop - iterate while condition is true
            let iteration = 0;
            const maxIterations = loopConfig.maxIterations || 100;
            
            while (iteration < maxIterations && !this.isCancelled) {
                // Re-evaluate condition
                const conditionResult = this.context.evaluate(loopConfig.condition);
                if (!conditionResult) break;
                
                // Update iteration count
                const state = this.nodeStates.get(node.id)!;
                state.outputs.iteration = iteration;
                this.context.addNodeOutputs(node.id, state.outputs);
                
                // Execute loop body
                for (const conn of loopBodyConnections) {
                    this.resetNodeState(conn.toNodeId);
                    await this.executeNode(conn.toNodeId);
                }
                
                iteration++;
            }
        }
        
        // Execute complete path
        for (const conn of completeConnections) {
            await this.executeNode(conn.toNodeId);
        }
    }
    
    /**
     * Handle subgraph execution
     */
    private async handleSubgraph(
        node: INodeInstance,
        subgraphConfig: {
            path: string;
            input: any;
            inheritVariables: boolean;
        }
    ): Promise<void> {
        log.debug(`Executing subgraph: ${subgraphConfig.path}`);
        
        // Load subgraph
        const subgraph = await this.graphLoader.load(subgraphConfig.path);
        
        // Create execution context for subgraph
        const services = this.context.getWorkflowServices();
        const subContext = new ExecutionContext(
            subgraph,
            services,
            `sub_${node.id}`,
            'subgraph'
        );
        
        // Inherit variables if configured
        if (subgraphConfig.inheritVariables) {
            subContext.restoreVariables(this.context.getAllVariables());
        }
        
        // Execute subgraph
        const subEngine = new NodeExecutionEngine(subgraph, subContext, {
            debugOptions: this.debugOptions,
            debugCallback: this.debugCallback
        });
        
        const result = await subEngine.execute(subgraphConfig.input);
        
        // Update node outputs
        const state = this.nodeStates.get(node.id)!;
        state.outputs.output = result.output;
        state.outputs.success = result.success;
        
        // Continue downstream
        await this.executeDownstream(node.id);
    }
    
    /**
     * Reset a node state for re-execution (loops)
     */
    private resetNodeState(nodeId: string): void {
        const state = this.nodeStates.get(nodeId);
        if (state) {
            state.status = 'pending';
            state.inputs = {};
            state.outputs = {};
            state.result = undefined;
            state.retryCount = 0;
        }
    }
    
    /**
     * Handle node error with retry/skip/abort/goto strategies
     */
    private async handleNodeError(
        node: INodeInstance,
        error: any,
        state: NodeState
    ): Promise<boolean> {
        const errorConfig = node.onError;
        if (!errorConfig) {
            return false; // No error handling, propagate error
        }
        
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        switch (errorConfig.strategy) {
            case 'retry':
                const maxRetries = errorConfig.maxRetries || 3;
                if (state.retryCount < maxRetries) {
                    state.retryCount++;
                    const delayMs = errorConfig.retryDelayMs || 1000;
                    
                    log.warn(`Node ${node.id} failed, retrying (${state.retryCount}/${maxRetries}) in ${delayMs}ms`);
                    
                    await this.context.sleep(delayMs);
                    
                    // Reset state and re-execute
                    state.status = 'pending';
                    await this.executeNode(node.id);
                    return true;
                }
                return false;
                
            case 'skip':
                // WARNING: 'skip' strategy masks errors with default values
                // Only use this if you understand the error will be hidden from users
                const defaultValue = errorConfig.skipDefaultValue || {};
                log.error(
                    `Node ${node.id} FAILED but using 'skip' strategy. ` +
                    `Error is being masked with default value. ` +
                    `Original error: ${error instanceof Error ? error.message : String(error)}`
                );
                state.status = 'skipped';
                state.outputs = defaultValue;
                state.error = `Skipped due to error: ${error instanceof Error ? error.message : String(error)}`;
                await this.executeDownstream(node.id);
                return true;
                
            case 'goto':
                if (errorConfig.gotoNodeId) {
                    log.warn(`Node ${node.id} failed, jumping to ${errorConfig.gotoNodeId}`);
                    state.status = 'failed';
                    await this.executeNode(errorConfig.gotoNodeId);
                    return true;
                }
                return false;
                
            case 'abort':
            default:
                return false;
        }
    }
    
    /**
     * Execute with timeout
     */
    private async executeWithTimeout<T>(
        fn: () => Promise<T>,
        timeoutMs: number
    ): Promise<T> {
        return Promise.race([
            fn(),
            new Promise<T>((_, reject) => 
                setTimeout(() => reject(new Error('Execution timeout')), timeoutMs)
            )
        ]);
    }
    
    /**
     * Save execution checkpoint
     */
    private async saveCheckpoint(): Promise<void> {
        if (!this.checkpointPath) return;
        
        const checkpoint: IExecutionCheckpoint = {
            workflowId: 'current',
            sessionId: 'current',
            graphName: this.graph.name,
            timestamp: new Date().toISOString(),
            completedNodes: Array.from(this.nodeStates.entries())
                .filter(([_, s]) => s.status === 'completed')
                .map(([id, _]) => id),
            contextSnapshot: this.context.getAllVariables(),
            nodeResults: Object.fromEntries(
                Array.from(this.nodeStates.entries())
                    .filter(([_, s]) => s.result)
                    .map(([id, s]) => [id, s.result!])
            ),
            runningNodes: Array.from(this.nodeStates.entries())
                .filter(([_, s]) => s.status === 'running')
                .map(([id, _]) => id)
        };
        
        await fs.promises.writeFile(
            this.checkpointPath,
            JSON.stringify(checkpoint, null, 2),
            'utf-8'
        );
        
        log.debug(`Checkpoint saved: ${this.checkpointPath}`);
    }
    
    /**
     * Restore from checkpoint
     */
    async restoreFromCheckpoint(checkpointPath: string): Promise<void> {
        const content = await fs.promises.readFile(checkpointPath, 'utf-8');
        const checkpoint: IExecutionCheckpoint = JSON.parse(content);
        
        // Restore context variables
        this.context.restoreVariables(checkpoint.contextSnapshot);
        
        // Restore node states
        for (const nodeId of checkpoint.completedNodes) {
            const state = this.nodeStates.get(nodeId);
            if (state) {
                state.status = 'completed';
                if (checkpoint.nodeResults[nodeId]) {
                    state.result = checkpoint.nodeResults[nodeId];
                    state.outputs = checkpoint.nodeResults[nodeId].outputs;
                }
            }
        }
        
        log.info(`Restored from checkpoint: ${checkpoint.completedNodes.length} nodes completed`);
    }
    
    /**
     * Pause execution
     */
    pause(): void {
        this.isPaused = true;
    }
    
    /**
     * Resume execution
     */
    resume(): void {
        this.isPaused = false;
        if (this.stepResolve) {
            this.stepResolve();
            this.stepResolve = undefined;
        }
    }
    
    /**
     * Step to next node (debug mode)
     */
    step(): void {
        if (this.stepResolve) {
            this.stepResolve();
            this.stepResolve = undefined;
        }
    }
    
    /**
     * Cancel execution
     */
    cancel(): void {
        this.isCancelled = true;
        this.context.stop();
        if (this.stepResolve) {
            this.stepResolve();
        }
    }
    
    /**
     * Wait for step/resume in debug mode
     */
    private async waitForStep(nodeId: string): Promise<void> {
        if (this.isCancelled) return;
        
        this.debugCallback?.('step', nodeId);
        
        await new Promise<void>(resolve => {
            this.stepResolve = resolve;
        });
    }
    
    /**
     * Get current execution state (for UI/debugging)
     */
    getExecutionState(): Map<string, NodeState> {
        return new Map(this.nodeStates);
    }
}

