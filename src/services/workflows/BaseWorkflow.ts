// ============================================================================
// BaseWorkflow - Abstract base class for all workflow implementations
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TypedEventEmitter } from '../TypedEventEmitter';
import { IWorkflow, WorkflowServices, TaskOccupancy, TaskConflict } from './IWorkflow';
import { 
    WorkflowType, 
    WorkflowStatus, 
    WorkflowProgress, 
    WorkflowResult,
    WorkflowConfig,
    AgentRequest,
    AgentCompletionSignal,
    AgentStage,
    AgentStageResult,
    AgentCompletionPayload
} from '../../types/workflow';
import { ModelTier } from '../../types';
import { StateManager } from '../StateManager';
import { AgentPoolService } from '../AgentPoolService';
import { AgentRoleRegistry } from '../AgentRoleRegistry';
import { UnityControlManager } from '../UnityControlManager';
import { OutputChannelManager } from '../OutputChannelManager';
import { ProcessManager, ProcessState } from '../ProcessManager';
import { ServiceLocator } from '../ServiceLocator';
import { Logger } from '../../utils/Logger';

const log = Logger.create('Daemon', 'BaseWorkflow');

/**
 * Result from running an agent task with CLI callback
 */
export interface AgentTaskResult {
    /** Whether the task succeeded */
    success: boolean;
    /** The result type from the agent (success, failed, approved, changes_requested, etc.) */
    result: AgentStageResult;
    /** Structured payload from the agent */
    payload?: AgentCompletionPayload;
    /** Whether this result came from CLI callback (true) or error path (false) */
    fromCallback: boolean;
}

/**
 * Abstract base class for workflows
 * 
 * Provides common functionality:
 * - Phase-based execution loop
 * - Agent request/release helpers
 * - Progress emission
 * - Logging to OutputChannelManager
 * - Service injection
 * 
 * Subclasses implement:
 * - getPhases(): string[]
 * - executePhase(index: number): Promise<void>
 * - getState(): object
 * - getProgressMessage(): string
 * - getOutput(): any
 */
export abstract class BaseWorkflow implements IWorkflow {
    // ========================================================================
    // Identity (from IWorkflow)
    // ========================================================================
    
    readonly id: string;
    readonly type: WorkflowType;
    readonly sessionId: string;
    
    // ========================================================================
    // Internal State
    // ========================================================================
    
    protected status: WorkflowStatus = 'pending';
    protected lastError: string | undefined;  // Error message if workflow failed
    protected phaseIndex: number = 0;
    protected startTime: number = 0;
    protected allocatedAgents: string[] = [];
    protected benchedAgents: string[] = [];  // Agents demoted to bench (still allocated, but idle)
    protected input: Record<string, any>;
    protected priority: number;
    
    /** Extra instruction to inject into all agent prompts (e.g., from user clarifications) */
    protected extraInstruction?: string;
    
    // Agent waiting state
    protected waitingForAgent: boolean = false;
    protected waitingForAgentRole: string | undefined;
    
    // Agent work counter - increments each time an agent is put to work
    // Used for unique log file naming: {workflowId}_{workCount}_{agentName}.log
    protected agentWorkCount: number = 0;
    
    // Track if workflow has started running (becomes true after first agent allocation)
    private hasStartedRunning: boolean = false;
    
    // Pending event responses - for waitForWorkflowEvent
    private pendingEventWaiters: Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timeoutId?: NodeJS.Timeout;
    }> = new Map();
    
    // ========================================================================
    // Events (from IWorkflow)
    // ========================================================================
    
    readonly onProgress = new TypedEventEmitter<WorkflowProgress>();
    readonly onComplete = new TypedEventEmitter<WorkflowResult>();
    readonly onError = new TypedEventEmitter<Error>();
    readonly onAgentNeeded = new TypedEventEmitter<AgentRequest>();
    readonly onAgentReleased = new TypedEventEmitter<string>();
    readonly onAgentDemotedToBench = new TypedEventEmitter<string>();
    readonly onWorkflowEvent = new TypedEventEmitter<{ eventType: string; payload?: any }>();
    readonly onAgentTerminated = new TypedEventEmitter<{
        agentName: string;
        runId: string;
        reason: 'external_kill' | 'timeout' | 'error' | 'health_check_failed';
        phase?: string;
    }>();
    
    /** Fired when an agent starts working on a task (with correct log file path) */
    readonly onAgentWorkStarted = new TypedEventEmitter<{
        agentName: string;
        sessionId: string;
        roleId: string;
        workflowId: string;
        taskId: string;
        workCount: number;
        logFile: string;
    }>();
    
    // Task occupancy/conflict events
    readonly onTaskOccupancyDeclared = new TypedEventEmitter<TaskOccupancy>();
    readonly onTaskOccupancyReleased = new TypedEventEmitter<string[]>();
    readonly onTaskConflictDeclared = new TypedEventEmitter<TaskConflict>();
    
    // ========================================================================
    // Task Occupancy State
    // ========================================================================
    
    /** Task IDs this workflow is currently occupying */
    protected occupiedTaskIds: string[] = [];
    
    /** Task IDs this workflow conflicts with */
    protected conflictingTaskIds: string[] = [];
    
    // ========================================================================
    // Agent Tracking
    // ========================================================================
    
    /** Current agent run ID (if an agent is actively running) */
    protected currentAgentRunId: string | undefined;
    
    /** ProcessManager callback IDs for cleanup */
    private processManagerCallbackIds: string[] = [];
    
    // ========================================================================
    // Logging
    // ========================================================================
    
    /** Path to persistent workflow log file (logs/{workflow_id}.log) */
    protected workflowLogPath: string | undefined;
    
    // ========================================================================
    // Injected Services
    // ========================================================================
    
    protected stateManager: StateManager;
    protected agentPoolService: AgentPoolService;
    protected roleRegistry: AgentRoleRegistry;
    /** Unity Control Manager - only available when unityEnabled is true */
    protected unityManager: UnityControlManager | undefined;
    protected outputManager: OutputChannelManager;
    protected processManager: ProcessManager;
    
    /** Whether Unity features are enabled for this workflow */
    protected unityEnabled: boolean;
    
    // ========================================================================
    // Static Metadata - Subclasses can override
    // ========================================================================
    
    /** 
     * Whether this workflow requires Unity features to function.
     * If true, workflow won't be available when Unity features are disabled.
     * Subclasses should override this if they require Unity.
     */
    static readonly requiresUnity: boolean = false;
    
    // ========================================================================
    // APC CLI Path Resolution
    // ========================================================================
    
    /** Cached absolute path to apc CLI */
    private static _apcPath: string | null = null;
    
    /**
     * Clear the cached apc CLI path.
     * Call this after installation to force re-resolution on next use.
     */
    public static clearApcPathCache(): void {
        BaseWorkflow._apcPath = null;
        log.debug('Cleared apc CLI path cache');
    }
    
    /**
     * Get the absolute path to the apc CLI command.
     * 
     * Checks in order:
     * 1. Windows: ~/bin/apc.cmd
     * 2. Unix: ~/.local/bin/apc (standard install location)
     * 3. Unix: /usr/local/bin/apc (alternative location)
     * 4. Falls back to 'apc' (relies on PATH)
     * 
     * Result is cached for performance.
     */
    protected static getApcPath(): string {
        if (BaseWorkflow._apcPath !== null) {
            return BaseWorkflow._apcPath;
        }
        
        const platform = process.platform;
        
        if (platform === 'win32') {
            // Windows: Check ~/bin/apc.cmd
            const winBinPath = path.join(os.homedir(), 'bin', 'apc.cmd');
            if (fs.existsSync(winBinPath)) {
                BaseWorkflow._apcPath = winBinPath;
                log.debug(`Using apc at: ${winBinPath}`);
                return winBinPath;
            }
        } else {
            // Unix: Check standard locations
            const homeBinPath = path.join(os.homedir(), '.local', 'bin', 'apc');
            const usrLocalPath = '/usr/local/bin/apc';
            
            if (fs.existsSync(homeBinPath)) {
                BaseWorkflow._apcPath = homeBinPath;
                log.debug(`Using apc at: ${homeBinPath}`);
                return homeBinPath;
            }
            
            if (fs.existsSync(usrLocalPath)) {
                BaseWorkflow._apcPath = usrLocalPath;
                log.debug(`Using apc at: ${usrLocalPath}`);
                return usrLocalPath;
            }
        }
        
        // Also check PATH in case apc is installed elsewhere
        // This is explicit secondary check, not a silent fallback
        log.info('apc not found at standard locations, checking PATH for non-standard installation');
        BaseWorkflow._apcPath = 'apc';
        return 'apc';
    }
    
    /**
     * Get the apc command for use in prompts.
     * Returns absolute path if available, otherwise 'apc'.
     */
    protected get apcCommand(): string {
        return BaseWorkflow.getApcPath();
    }
    
    // ========================================================================
    // Constructor
    // ========================================================================
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        this.id = config.id;
        this.type = config.type;
        this.sessionId = config.sessionId;
        this.priority = config.priority;
        this.input = config.input;
        
        this.stateManager = services.stateManager;
        this.agentPoolService = services.agentPoolService;
        this.roleRegistry = services.roleRegistry;
        this.unityManager = services.unityManager;
        this.outputManager = services.outputManager;
        this.processManager = ServiceLocator.resolve(ProcessManager);
        this.unityEnabled = services.unityEnabled;
        
        // Extract extra instruction from input (e.g., user clarifications)
        if (config.input?.extraInstruction) {
            this.extraInstruction = config.input.extraInstruction;
        }
        
        // Initialize workflow log file (persistent)
        this.initializeWorkflowLog();
        
        // Subscribe to ProcessManager events for agent health monitoring
        this.setupProcessManagerMonitoring();
    }
    
    /**
     * Initialize the persistent workflow log file
     */
    private initializeWorkflowLog(): void {
        try {
            const planFolder = this.stateManager.getPlanFolder(this.sessionId);
            if (planFolder) {
                const logDir = path.join(planFolder, 'logs', 'workflow');
                if (!fs.existsSync(logDir)) {
                    fs.mkdirSync(logDir, { recursive: true });
                }
                this.workflowLogPath = path.join(logDir, `${this.id}.log`);
                // Write header
                const header = `=== Workflow Log: ${this.type} ===\nID: ${this.id}\nSession: ${this.sessionId}\nStarted: ${new Date().toISOString()}\n${'='.repeat(50)}\n\n`;
                fs.writeFileSync(this.workflowLogPath, header);
            }
        } catch {
            // Silently ignore log initialization errors
        }
    }
    
    /**
     * Setup ProcessManager monitoring for agent health
     * Delegates health checking to ProcessManager (separation of concerns)
     */
    private setupProcessManagerMonitoring(): void {
        // Register callback for stuck processes (no output for 5+ minutes)
        const stuckCallbackId = this.processManager.onProcessStuck((processId, state) => {
            // Check if this is one of our agent processes
            if (processId.startsWith(this.id) && this.currentAgentRunId === processId) {
                this.log(`⚠️ Agent process appears stuck: ${processId}`);
                this.handleAgentUnexpectedTermination(processId, 'health_check_failed', state);
            }
        });
        
        // Register callback for process timeouts
        const timeoutCallbackId = this.processManager.onProcessTimeout((processId, state) => {
            // Check if this is one of our agent processes
            if (processId.startsWith(this.id) && this.currentAgentRunId === processId) {
                this.log(`⏰ Agent process timed out: ${processId}`);
                this.handleAgentUnexpectedTermination(processId, 'timeout', state);
            }
        });
        
        // Store callback IDs for cleanup
        this.processManagerCallbackIds.push(stuckCallbackId, timeoutCallbackId);
    }
    
    /**
     * Handle unexpected agent termination detected by ProcessManager
     */
    private handleAgentUnexpectedTermination(
        runId: string,
        reason: 'external_kill' | 'timeout' | 'error' | 'health_check_failed',
        processState?: ProcessState
    ): void {
        // Find which agent this was
        const agentName = this.allocatedAgents.find(name => 
            processState?.metadata?.agentName === name
        );
        
        const phaseName = this.getPhases()[this.phaseIndex] || 'unknown';
        
        this.log(`❌ Agent terminated unexpectedly: ${reason}`);
        this.log(`  Run ID: ${runId}`);
        this.log(`  Phase: ${phaseName}`);
        if (agentName) {
            this.log(`  Agent: ${agentName}`);
        }
        
        // Fire termination event
        this.onAgentTerminated.fire({
            agentName: agentName || 'unknown',
            runId,
            reason,
            phase: phaseName
        });
        
        // Clear current agent run ID so we don't wait for it
        if (this.currentAgentRunId === runId) {
            this.currentAgentRunId = undefined;
        }
        
        // Note: The agent runner's Promise will reject, which will be caught
        // by the try-catch in runAgentTaskWithCallback or executePhase
        // We don't need to do anything else here - just log and notify
    }
    
    // ========================================================================
    // Abstract Methods - Subclasses MUST implement
    // ========================================================================
    
    /** Get the list of phase names for this workflow */
    abstract getPhases(): string[];
    
    /** Execute a specific phase by index */
    abstract executePhase(phaseIndex: number): Promise<void>;
    
    /** Get serializable state for persistence */
    abstract getState(): object;
    
    /** Get human-readable progress message */
    protected abstract getProgressMessage(): string;
    
    /** Get workflow output when complete */
    protected abstract getOutput(): any;
    
    // ========================================================================
    // IWorkflow Implementation - State
    // ========================================================================
    
    getStatus(): WorkflowStatus {
        return this.status;
    }
    
    getError(): string | undefined {
        return this.lastError;
    }
    
    getProgress(): WorkflowProgress {
        const phases = this.getPhases();
        
        // Extract taskId from input for task workflows
        let taskId: string | undefined;
        if (this.type === 'task_implementation' && 'taskId' in this.input) {
            taskId = this.input.taskId as string;
        } else if (this.type === 'error_resolution' && 'errors' in this.input) {
            // For error resolution, try to get taskId from the first error's relatedTaskId
            const errors = this.input.errors as Array<{ relatedTaskId?: string }>;
            taskId = errors[0]?.relatedTaskId;
        } else if (this.type === 'context_gathering' && 'taskId' in this.input) {
            // For context_gathering, taskId is optional - used when gathering context for a specific task
            taskId = this.input.taskId as string;
        }
        
        return {
            workflowId: this.id,
            type: this.type,
            status: this.status,
            phase: phases[this.phaseIndex] || 'unknown',
            phaseIndex: this.phaseIndex,
            totalPhases: phases.length,
            percentage: phases.length > 0 
                ? (this.phaseIndex / phases.length) * 100 
                : 0,
            message: this.getProgressMessage(),
            startedAt: this.startTime > 0 
                ? new Date(this.startTime).toISOString() 
                : '',
            updatedAt: new Date().toISOString(),
            taskId,
            logPath: this.workflowLogPath,
            waitingForAgent: this.waitingForAgent,
            waitingForAgentRole: this.waitingForAgentRole
        };
    }
    
    // ========================================================================
    // IWorkflow Implementation - Lifecycle
    // ========================================================================
    
    async start(): Promise<WorkflowResult> {
        if (this.status !== 'pending') {
            throw new Error(`Cannot start workflow in ${this.status} state`);
        }
        
        // NOTE: Status stays 'pending' until first agent is allocated
        // This prevents UI from showing "running workflow with no agents" warnings
        this.startTime = Date.now();
        this.log(`Starting workflow: ${this.type}`);
        this.emitProgress();
        
        try {
            await this.runPhases();
            
            this.status = 'succeeded';
            const result: WorkflowResult = {
                success: true,
                output: this.getOutput(),
                duration: Date.now() - this.startTime
            };
            
            this.log(`Workflow completed successfully`);
            
            this.onComplete.fire(result);
            return result;
            
        } catch (error) {
            this.status = 'failed';
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.lastError = errorMessage;  // Store error for coordinator visibility
            const result: WorkflowResult = {
                success: false,
                error: errorMessage,
                duration: Date.now() - this.startTime
            };
            
            this.log(`Workflow failed: ${errorMessage}`);
            
            this.onError.fire(error instanceof Error ? error : new Error(errorMessage));
            this.onComplete.fire(result);
            return result;
            
        } finally {
            // Release all allocated agents
            await this.releaseAllAgents();
        }
    }
    
    async cancel(): Promise<void> {
        this.log(`Cancelling`);
        this.status = 'cancelled';
        this.emitProgress();
        
        // Release task occupancy
        if (this.occupiedTaskIds.length > 0) {
            this.log(`Releasing ${this.occupiedTaskIds.length} task occupancies on cancel`);
            this.releaseTaskOccupancy([...this.occupiedTaskIds]);
        }
        
        // Release conflict declarations
        if (this.conflictingTaskIds.length > 0) {
            this.conflictingTaskIds = [];
        }
        
        // Release all agents
        await this.releaseAllAgents();
        
        // Kill any running agent
        if (this.currentAgentRunId) {
            const { AgentRunner } = await import('../AgentBackend');
            const agentRunner = ServiceLocator.resolve(AgentRunner);
            await agentRunner.stop(this.currentAgentRunId);
            this.currentAgentRunId = undefined;
        }
        
        this.onComplete.fire({
            success: false,
            error: 'Workflow cancelled',
            duration: Date.now() - this.startTime
        });
    }
    
    // ========================================================================
    // IWorkflow Implementation - Task Occupancy & Conflict
    // ========================================================================
    
    /**
     * Get task IDs this workflow is currently occupying
     * Subclasses should override to return their occupied tasks
     */
    getOccupiedTaskIds(): string[] {
        return [...this.occupiedTaskIds];
    }
    
    /**
     * Get task IDs this workflow conflicts with
     * Subclasses should override to return conflicting tasks
     * Return empty array if no conflicts
     */
    getConflictingTaskIds(): string[] {
        return [...this.conflictingTaskIds];
    }
    
    /**
     * Handle a conflict detected by the coordinator
     * Default: wait for the other workflow
     * Subclasses can override for different behavior
     */
    handleConflict(taskId: string, otherWorkflowId: string): 'wait' | 'proceed' | 'abort' {
        this.log(`Conflict on task ${taskId} with workflow ${otherWorkflowId}, waiting...`);
        return 'wait';
    }
    
    /**
     * Called when conflicts are resolved
     * Default: just log. Subclasses can override for custom behavior.
     */
    onConflictsResolved(resolvedTaskIds: string[]): void {
        this.log(`Conflicts resolved for tasks: ${resolvedTaskIds.join(', ')}`);
    }
    
    // ========================================================================
    // IWorkflow Implementation - Dependency Management
    // ========================================================================
    
    getDependencies(): string[] {
        // Default: no dependencies. Subclasses can override.
        return [];
    }
    
    isBlocking(): boolean {
        // Default: not blocking. Revision workflows override this.
        return false;
    }
    
    /**
     * Get the input used to create this workflow (for re-creation during recovery)
     */
    getInput(): Record<string, any> {
        return this.input;
    }
    
    /**
     * Get the priority of this workflow
     */
    getPriority(): number {
        return this.priority;
    }
    
    /**
     * Get all agents allocated to this workflow (busy + benched)
     */
    getAllocatedAgentNames(): string[] {
        return [...this.allocatedAgents, ...this.benchedAgents];
    }
    
    // ========================================================================
    // IWorkflow Implementation - Cleanup
    // ========================================================================
    
    dispose(): void {
        // Unregister ProcessManager callbacks to prevent memory leaks
        for (const callbackId of this.processManagerCallbackIds) {
            if (callbackId.startsWith('stuck_')) {
                this.processManager.offProcessStuck(callbackId);
            } else if (callbackId.startsWith('timeout_')) {
                this.processManager.offProcessTimeout(callbackId);
            }
        }
        this.processManagerCallbackIds = [];
        
        // Release any remaining task occupancy
        if (this.occupiedTaskIds.length > 0) {
            this.releaseTaskOccupancy(this.occupiedTaskIds);
        }
        
        this.currentAgentRunId = undefined;
        
        // Clear allocated agents array
        this.allocatedAgents = [];
        this.benchedAgents = [];
        
        // Clear task tracking
        this.occupiedTaskIds = [];
        this.conflictingTaskIds = [];
        
        // Dispose event emitters (this removes all listeners)
        this.onProgress.dispose();
        this.onComplete.dispose();
        this.onError.dispose();
        this.onAgentNeeded.dispose();
        this.onAgentReleased.dispose();
        this.onAgentTerminated.dispose();
        this.onAgentWorkStarted.dispose();
        this.onTaskOccupancyDeclared.dispose();
        this.onTaskOccupancyReleased.dispose();
        this.onTaskConflictDeclared.dispose();
        this.onWorkflowEvent.dispose();
        
        // Reject any pending event waiters
        for (const [eventType, waiter] of this.pendingEventWaiters) {
            if (waiter.timeoutId) {
                clearTimeout(waiter.timeoutId);
            }
            waiter.reject(new Error(`Workflow disposed while waiting for event: ${eventType}`));
        }
        this.pendingEventWaiters.clear();
        
        // Clear input to release any large objects
        this.input = {};
    }
    
    // ========================================================================
    // Protected Helpers
    // ========================================================================
    
    /**
     * Run through all phases sequentially with retry support
     */
    protected async runPhases(): Promise<void> {
        const phases = this.getPhases();
        
        while (this.phaseIndex < phases.length) {
            // Check for cancellation (use type assertion due to TS narrowing)
            const currentStatus: WorkflowStatus = this.status;
            if (currentStatus === 'cancelled') {
                return;
            }
            
            this.log(`Phase ${this.phaseIndex + 1}/${phases.length}: ${phases[this.phaseIndex]}`);
            this.emitProgress();
            
            // Execute phase (errors propagate up, coordinator handles retry)
            await this.runPhase(this.phaseIndex);
            this.phaseIndex++;
        }
    }
    
    /**
     * Run a phase with error classification
     * 
     * When a phase fails:
     * 1. Error is classified and logged
     * 2. Error propagates up to start()
     * 3. Workflow fails and releases all agents via releaseAllAgents()
     * 4. Coordinator sees the failed task and can spawn a new workflow to retry
     */
    protected async runPhase(phaseIndex: number): Promise<void> {
        const { ErrorClassifier } = await import('./ErrorClassifier');
        const classifier = ServiceLocator.resolve(ErrorClassifier);
        const phases = this.getPhases();
        const phaseName = phases[phaseIndex];
        
        try {
            await this.executePhase(phaseIndex);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const classification = classifier.classify(errorMessage);
            
            this.log(`Phase ${phaseName} failed: ${errorMessage.substring(0, 100)}`);
            this.log(`  Error type: ${classification.type} (${classification.category})`);
            this.log(`  ❌ Workflow will fail - coordinator handles retry at task level`);
            throw error;
        }
    }
    
    /**
     * Emit progress event to listeners
     */
    protected emitProgress(): void {
        this.onProgress.fire(this.getProgress());
    }
    
    /**
     * Log message with workflow context
     * Writes to both Output panel and persistent workflow log file
     */
    protected log(message: string): void {
        const prefix = `WF:${this.id.substring(0, 12)}`;
        this.outputManager.log(prefix, message);
        
        // Also write to persistent workflow log file
        if (this.workflowLogPath) {
            try {
                const timestamp = new Date().toISOString();
                fs.appendFileSync(this.workflowLogPath, `[${timestamp}] ${message}\n`, 'utf8');
            } catch {
                // Silently ignore file write errors
            }
        }
    }
    
    /**
     * Get the workflow log file path (for UI to open)
     */
    getWorkflowLogPath(): string | undefined {
        return this.workflowLogPath;
    }
    
    /**
     * Request an agent from the pool
     * 
     * NEW ARCHITECTURE:
     * 1. Requests agent allocation to bench
     * 2. Immediately promotes to busy when allocated
     * 3. Workflows can demote to bench if agent isn't immediately needed
     * 
     * Returns a promise that resolves with the agent name when allocated
     */
    protected requestAgent(roleId: string): Promise<string> {
        return new Promise((resolve) => {
            // Set waiting state and emit progress update
            this.waitingForAgent = true;
            this.waitingForAgentRole = roleId;
            this.emitProgress();
            this.log(`Waiting for agent with role: ${roleId}`);
            
            const request: AgentRequest = {
                workflowId: this.id,
                roleId,
                priority: this.priority,
                callback: (agentName: string) => {
                    // Clear waiting state when agent is allocated
                    this.waitingForAgent = false;
                    this.waitingForAgentRole = undefined;
                    
                    // Agent is now on bench - promote to busy immediately
                    // (Workflows can demote back to bench if not immediately needed)
                    const { AgentPoolService } = require('../AgentPoolService');
                    const { ServiceLocator } = require('../ServiceLocator');
                    const agentPoolService = ServiceLocator.resolve(AgentPoolService);
                    
                    const promoted = agentPoolService.promoteAgentToBusy(
                        agentName,
                        this.id,
                        roleId  // Use roleId as task description
                    );
                    
                    if (!promoted) {
                        this.log(`⚠️ Failed to promote ${agentName} to busy - already working?`);
                    }
                    
                    // Change status to 'running' on first agent allocation
                    // This ensures UI sees workflow as running only after agent is assigned
                    if (!this.hasStartedRunning && this.status === 'pending') {
                        this.status = 'running';
                        this.hasStartedRunning = true;
                        this.log(`Workflow status changed to running (first agent allocated)`);
                    }
                    
                    // Remove from benched if this agent was previously on bench
                    const benchIndex = this.benchedAgents.indexOf(agentName);
                    if (benchIndex >= 0) {
                        this.benchedAgents.splice(benchIndex, 1);
                        this.log(`Agent ${agentName} promoted from bench to busy`);
                    }
                    
                    this.allocatedAgents.push(agentName);
                    this.log(`Agent allocated and promoted to busy: ${agentName} (role: ${roleId})`);
                    
                    // Emit progress update to clear waiting indicator in UI
                    this.emitProgress();
                    
                    resolve(agentName);
                }
            };
            
            this.onAgentNeeded.fire(request);
        });
    }
    
    /**
     * Release a specific agent back to the pool
     */
    protected releaseAgent(agentName: string): void {
        let released = false;
        
        // Check allocatedAgents first
        const allocatedIndex = this.allocatedAgents.indexOf(agentName);
        if (allocatedIndex >= 0) {
            this.allocatedAgents.splice(allocatedIndex, 1);
            released = true;
        }
        
        // Also check benchedAgents (agents demoted to bench are still allocated)
        const benchedIndex = this.benchedAgents.indexOf(agentName);
        if (benchedIndex >= 0) {
            this.benchedAgents.splice(benchedIndex, 1);
            released = true;
        }
        
        if (released) {
            this.log(`Agent released: ${agentName}`);
            log.debug(`Firing onAgentReleased for ${agentName}`);
            this.onAgentReleased.fire(agentName);
            log.debug(`onAgentReleased fired for ${agentName}`);
        } else {
            log.debug(`Agent ${agentName} not in allocatedAgents or benchedAgents, skipping release`);
        }
    }
    
    
    /**
     * Demote agent to bench (allocated but idle, waiting for more work)
     */
    protected demoteAgentToBench(agentName: string): void {
        const index = this.allocatedAgents.indexOf(agentName);
        if (index >= 0) {
            this.allocatedAgents.splice(index, 1);
            // Track benched agent so we can release it if workflow is cancelled
            if (!this.benchedAgents.includes(agentName)) {
                this.benchedAgents.push(agentName);
            }
            this.log(`Agent demoted to bench: ${agentName}`);
            log.debug(`Firing onAgentDemotedToBench for ${agentName}`);
            this.onAgentDemotedToBench.fire(agentName);
            log.debug(`onAgentDemotedToBench fired for ${agentName}`);
        } else {
            log.debug(`Agent ${agentName} not in allocatedAgents, skipping demote`);
        }
    }
    
    /**
     * Release all allocated agents (including those on bench)
     */
    protected async releaseAllAgents(): Promise<void> {
        // Release active agents
        const agents = [...this.allocatedAgents];
        for (const agent of agents) {
            this.releaseAgent(agent);
        }
        
        // Also release benched agents (they were demoted but still allocated)
        const benched = [...this.benchedAgents];
        for (const agent of benched) {
            log.debug(`Releasing benched agent ${agent}`);
            this.benchedAgents = this.benchedAgents.filter(a => a !== agent);
            this.onAgentReleased.fire(agent);
        }
    }
    
    /**
     * Set workflow status to blocked
     */
    protected setBlocked(reason?: string): void {
        this.status = 'blocked';
        if (reason) {
            this.log(`Blocked: ${reason}`);
        }
        this.emitProgress();
    }
    
    /**
     * Set workflow status back to running (from blocked)
     */
    protected setUnblocked(): void {
        if (this.status === 'blocked') {
            this.status = 'running';
            this.emitProgress();
        }
    }
    
    /**
     * Sleep for specified milliseconds
     */
    protected sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Get a role from the registry (with Unity additions applied if enabled)
     */
    protected getRole(roleId: string) {
        return this.roleRegistry.getEffectiveRole(roleId);
    }
    
    /**
     * Get the raw role without Unity modifications
     */
    protected getRoleRaw(roleId: string) {
        return this.roleRegistry.getRole(roleId);
    }
    
    /**
     * Get effective system prompt for a role
     */
    protected getSystemPrompt(promptId: string): string {
        return this.roleRegistry.getEffectiveSystemPrompt(promptId);
    }
    
    /**
     * Check if Unity features are available for this workflow
     */
    protected isUnityAvailable(): boolean {
        return this.unityEnabled && this.unityManager !== undefined;
    }
    
    /**
     * Append extra instruction to a prompt if available.
     * Used by subclasses when building agent prompts.
     * 
     * @param basePrompt The base prompt to append to
     * @returns The prompt with extra instruction appended, if any
     */
    protected appendExtraInstruction(basePrompt: string): string {
        if (!this.extraInstruction) {
            return basePrompt;
        }
        
        return `${basePrompt}

## Additional Instructions from User
${this.extraInstruction}`;
    }
    
    // ========================================================================
    // Agent Task Execution with Output Parsing
    // ========================================================================
    
    /**
     * Run an agent task and parse output to determine result
     * 
     * This is the primary method for running agent tasks with structured results.
     * The workflow waits for the agent process to exit, then parses the output
     * to determine the result. Agents do NOT need to call any CLI commands.
     * 
     * The flow is:
     * 1. Start the agent process with summary instructions
     * 2. Wait for process to exit
     * 3. Parse output (task summary block or stage-specific patterns)
     * 4. Return structured result based on parsed output + exit code
     * 
     * @param taskId Human-readable task ID for logging
     * @param prompt The prompt to send to the agent
     * @param roleId The role ID for the agent
     * @param options Configuration for the agent run
     * @returns Promise with structured result
     */
    protected async runAgentTaskWithCallback(
        taskId: string,
        prompt: string,
        roleId: string,
        options: {
            /** Stage name for result mapping (e.g., 'implementation', 'review') */
            expectedStage: AgentStage;
            /** Timeout in milliseconds (default 10 minutes) */
            timeout?: number;
            /** Custom model tier to use instead of role default (low/mid/high) */
            model?: ModelTier;
            /** Working directory for the agent */
            cwd?: string;
            /** Pre-allocated agent name - if provided, uses this agent instead of requesting a new one */
            agentName?: string;
            /** Plan file path to stream plan content to (for planner streaming) */
            planFile?: string;
        }
    ): Promise<AgentTaskResult> {
        const { AgentRunner } = await import('../AgentBackend');
        const agentRunner = ServiceLocator.resolve(AgentRunner);
        
        const role = this.getRole(roleId);
        const timeout = options.timeout ?? role?.timeoutMs ?? 600000;
        
        this.log(`Starting agent task [${taskId}] (stage: ${options.expectedStage})`);
        
        // ============ TIMING: Track agent allocation ============
        const allocationStart = Date.now();
        
        // Use pre-allocated agent if provided, otherwise request a new one
        let agentName: string;
        if (options.agentName) {
            agentName = options.agentName;
            this.log(`  Using pre-allocated agent: ${agentName} (role: ${roleId}) [allocation: 0ms]`);
            
            // Check if agent needs to be promoted from bench to busy
            // Agent may already be busy (e.g., engineer allocated and not demoted)
            // or on bench (e.g., reviewer that was demoted after allocation)
            const { AgentPoolService } = await import('../AgentPoolService');
            const agentPoolService = ServiceLocator.resolve(AgentPoolService);
            const agentStatus = agentPoolService.getAgentStatus(agentName);
            
            if (agentStatus?.status === 'allocated') {
                // Agent is on bench - promote to busy
                const promoted = agentPoolService.promoteAgentToBusy(agentName, this.id, roleId);
                if (promoted) {
                    this.log(`  ⬆️ Promoted ${agentName} from bench to busy`);
                    
                    // CRITICAL: Update workflow's internal tracking to match AgentPoolService
                    // Remove from benchedAgents (agent is no longer idle on bench)
                    const benchIndex = this.benchedAgents.indexOf(agentName);
                    if (benchIndex >= 0) {
                        this.benchedAgents.splice(benchIndex, 1);
                    }
                    // Add to allocatedAgents (agent is now active for this workflow)
                    if (!this.allocatedAgents.includes(agentName)) {
                        this.allocatedAgents.push(agentName);
                    }
                } else {
                    this.log(`  ⚠️ Failed to promote ${agentName} to busy`);
                }
            } else if (agentStatus?.status === 'busy') {
                // Agent is already busy - no promotion needed
                this.log(`  ✓ Agent ${agentName} is already busy`);
            } else {
                this.log(`  ⚠️ Agent ${agentName} has unexpected status: ${agentStatus?.status || 'unknown'}`);
            }
        } else {
            this.log(`  Requesting new agent for role: ${roleId}...`);
            agentName = await this.requestAgent(roleId);
            const allocationDuration = Date.now() - allocationStart;
            this.log(`  Agent ${agentName} allocated for ${roleId} [allocation: ${allocationDuration}ms]`);
        }
        
        // Inject summary instructions into prompt (no CLI callback required)
        const enhancedPrompt = this.injectSummaryInstructions(
            prompt,
            options.expectedStage,
            roleId,
            taskId
        );
        
        // Start the agent process
        const runId = `${this.id}_${taskId}_${Date.now()}`;
        this.currentAgentRunId = runId;
        
        // Increment work counter for unique log file per agent task
        this.agentWorkCount++;
        const workCount = this.agentWorkCount;
        
        // Set up log file for streaming - unique per agent work assignment
        // Format: {workflowId}_{workCount}_{agentName}.log
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, `${this.id}_${workCount}_${agentName}.log`);
        
        // Log the agent's log file as clickable file URI
        const fileUri = `file:///${logFile.replace(/\\/g, '/')}`;
        this.log(`  📋 Agent log: ${fileUri}`);
        
        // Fire event with correct log file path for terminal streaming
        this.onAgentWorkStarted.fire({
            agentName,
            sessionId: this.sessionId,
            roleId,
            workflowId: this.id,
            taskId,
            workCount,
            logFile
        });
        
        try {
            // Wait for agent process to complete
            const processResult = await agentRunner.run({
                id: runId,
                prompt: enhancedPrompt,
                model: options.model ?? role?.defaultModel ?? 'mid' as ModelTier,
                cwd: options.cwd ?? process.cwd(),
                logFile,
                planFile: options.planFile,
                timeoutMs: timeout,
                onProgress: (msg) => this.log(`  ${msg}`),
                metadata: {
                    roleId,
                    coordinatorId: this.id,
                    sessionId: this.sessionId,
                    taskId,
                    agentName,
                    workflowType: this.type
                }
            });
            
            this.currentAgentRunId = undefined;
            const exitCode = processResult.exitCode ?? 0;
            this.log(`Agent [${taskId}] process exited (exit code: ${exitCode})`);
            
            // Parse output to determine result
            return await this.parseAgentOutputForResult(
                logFile,
                options.expectedStage,
                exitCode,
                taskId
            );
            
        } catch (error) {
            this.currentAgentRunId = undefined;
            await agentRunner.stop(runId).catch(() => {});
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.log(`Agent [${taskId}] failed: ${errorMessage}`);
            
            // Try to parse any output that was produced before the error
            try {
                const partialResult = await this.parseAgentOutputForResult(
                    logFile,
                    options.expectedStage,
                    1, // Assume non-zero exit for error cases
                    taskId
                );
                
                // If we got a meaningful result from partial output, use it
                if (partialResult.result !== 'needs_review') {
                    this.log(`  → Extracted result from partial output: ${partialResult.result}`);
                    return partialResult;
                }
            } catch {
                // Ignore parse errors for partial output
            }
            
            // Return needs_review for coordinator to verify
            this.log(`  → Marking as 'needs_review' for coordinator to verify`);
            return {
                success: true,  // Mark success so task goes to awaiting_decision
                result: 'needs_review',
                payload: { 
                    message: errorMessage,
                    needsCoordinatorDecision: true
                },
                fromCallback: true
            };
        }
        // NOTE: Agent lifecycle is managed by the caller, not here.
        // - TaskImplementationWorkflow demotes to bench (for implement→review→revise loop)
        // - ErrorResolutionWorkflow releases immediately
        // - Other workflows rely on releaseAllAgents() at workflow end
    }
    
    /**
     * Parse agent output to determine the task result
     * 
     * Looks for:
     * 1. Task summary block (===TASK_SUMMARY_START===...===TASK_SUMMARY_END===)
     * 2. Stage-specific patterns
     * 3. Falls back to exit code based defaults
     * 
     * @param logFile Path to agent log file
     * @param stage The expected stage for result mapping
     * @param exitCode The process exit code
     * @param taskId Task ID for logging
     * @returns Parsed result
     */
    private async parseAgentOutputForResult(
        logFile: string,
        stage: AgentStage,
        exitCode: number,
        taskId?: string
    ): Promise<AgentTaskResult> {
        // Try to extract task summary block first
        this.log(`  → Parsing agent output for result...`);
        const summary = await this.extractTaskSummary(logFile);
        
        if (summary.found) {
            this.log(`  📋 Found task summary: result=${summary.result}, message="${summary.message}"`);
            
            // Map summary result to valid stage result
            const { resultOptions } = this.getStageCallbackInfo(stage, taskId);
            let finalResult = 'needs_review';
            let needsCoordinatorDecision = false;
            
            if (summary.result) {
                const normalizedResult = summary.result.toLowerCase();
                const lowerOptions = resultOptions.map(r => r.toLowerCase());
                
                if (lowerOptions.includes(normalizedResult)) {
                    finalResult = normalizedResult;
                } else {
                    // Map to closest equivalent
                    const successAliases = ['success', 'complete', 'pass', 'approved', 'done', 'ok'];
                    const changesAliases = ['changes_requested', 'minor', 'needs_work', 'revise'];
                    const failureAliases = ['failed', 'critical', 'error', 'rejected'];
                    
                    if (successAliases.includes(normalizedResult)) {
                        finalResult = lowerOptions.find(o => successAliases.includes(o)) 
                            || resultOptions[0] || 'success';
                    } else if (changesAliases.includes(normalizedResult)) {
                        finalResult = lowerOptions.find(o => changesAliases.includes(o)) 
                            || lowerOptions.find(o => failureAliases.includes(o))
                            || 'failed';
                    } else if (failureAliases.includes(normalizedResult)) {
                        finalResult = lowerOptions.find(o => failureAliases.includes(o)) 
                            || 'failed';
                    }
                }
            } else {
                // Summary found but result is undefined - likely truncated
                needsCoordinatorDecision = true;
                this.log(`  ⚠️ Summary found but RESULT field is missing/undefined`);
            }
            
            this.log(`  ✓ Result from summary: ${finalResult}${needsCoordinatorDecision ? ' (needs coordinator decision)' : ''}`);
            
            const isSuccess = finalResult !== 'failed' || needsCoordinatorDecision;
            return {
                success: isSuccess,
                result: finalResult as AgentStageResult,
                payload: {
                    message: summary.message,
                    files: summary.files,
                    needsCoordinatorDecision: needsCoordinatorDecision || undefined
                },
                fromCallback: true
            };
        }
        
        // No summary block - try stage-specific pattern extraction
        this.log(`  → No summary block found, trying stage-specific pattern extraction...`);
        const extracted = await this.extractResultFromOutput(logFile, stage);
        
        if (extracted) {
            this.log(`  ✓ Pattern extraction succeeded: ${extracted.result}`);
            
            const isSuccess = extracted.result !== 'failed' && extracted.result !== 'critical';
            return {
                success: isSuccess,
                result: extracted.result as AgentStageResult,
                payload: extracted.message || extracted.files 
                    ? { message: extracted.message, files: extracted.files } 
                    : undefined,
                fromCallback: true
            };
        }
        
        // No patterns matched - use exit code based logic
        this.log(`  → No pattern matched in output`);
        
        if (exitCode !== 0) {
            // Non-zero exit code indicates crash/error
            this.log(`  → Exit code ${exitCode} indicates crash/error`);
            this.log(`  → Marking as 'needs_review' for coordinator to verify`);
            return {
                success: true,  // Mark success so task goes to awaiting_decision
                result: 'needs_review',
                payload: { 
                    message: `Agent process exited with code ${exitCode}. No recognizable output pattern found.`,
                    needsCoordinatorDecision: true
                },
                fromCallback: true
            };
        }
        
        // Exit code 0 but no patterns - use stage defaults
        this.log(`  → Exit code 0 but no recognizable output - using stage default`);
        const stageDefaults: Record<AgentStage, { result: AgentStageResult; success: boolean }> = {
            'implementation': { result: 'success', success: true },
            'fix': { result: 'success', success: true },
            'review': { result: 'needs_review', success: true },
            'analysis': { result: 'needs_review', success: true },
            'plan': { result: 'needs_review', success: true },
            'context_gathering': { result: 'success', success: true }
        };
        
        const stageDefault = stageDefaults[stage] || { result: 'needs_review', success: true };
        this.log(`  → Stage '${stage}' default: ${stageDefault.result}`);
        
        return {
            success: stageDefault.success,
            result: stageDefault.result,
            payload: { 
                message: `Agent completed (exit code 0) but no recognizable output. Using stage default: ${stageDefault.result}`,
                needsCoordinatorDecision: stageDefault.result === 'needs_review'
            },
            fromCallback: true
        };
    }
    
    /**
     * Extract task summary from log file (if agent wrote one)
     * Looks for ===TASK_SUMMARY_START=== / ===TASK_SUMMARY_END=== markers
     * 
     * @param logFile Path to the agent's log file
     * @returns Parsed summary or { found: false } if no summary
     */
    private async extractTaskSummary(logFile: string): Promise<{
        found: boolean;
        result?: string;
        message?: string;
        files?: string[];
    }> {
        try {
            const content = await fs.promises.readFile(logFile, 'utf-8');
            
            // Look for summary markers
            const startMarker = '===TASK_SUMMARY_START===';
            const endMarker = '===TASK_SUMMARY_END===';
            
            const startIdx = content.lastIndexOf(startMarker);
            const endIdx = content.lastIndexOf(endMarker);
            
            if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
                return { found: false };
            }
            
            const summaryBlock = content.substring(startIdx + startMarker.length, endIdx).trim();
            
            // Parse the structured summary
            const lines = summaryBlock.split('\n');
            let result: string | undefined;
            let message: string | undefined;
            let files: string[] | undefined;
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('RESULT:')) {
                    result = trimmed.substring(7).trim().toLowerCase();
                } else if (trimmed.startsWith('MESSAGE:')) {
                    message = trimmed.substring(8).trim();
                } else if (trimmed.startsWith('FILES:')) {
                    const filesStr = trimmed.substring(6).trim();
                    if (filesStr && filesStr.toLowerCase() !== 'none') {
                        files = filesStr.split(',').map(f => f.trim()).filter(Boolean);
                    }
                }
            }
            
            return {
                found: true,
                result,
                message,
                files
            };
        } catch (error) {
            this.log(`  ⚠️ Could not read log for summary extraction: ${error}`);
            return { found: false };
        }
    }
    
    /**
     * Extract result from agent output using stage-specific pattern matching
     * 
     * This is a fallback when the agent didn't write a TASK_SUMMARY block.
     * It tries to parse known output patterns for each stage type.
     * 
     * @param logFile Path to the agent's log file
     * @param stage The stage to extract result for
     * @returns Extracted result or null if no pattern matched
     */
    private async extractResultFromOutput(
        logFile: string,
        stage: AgentStage
    ): Promise<{
        result: string;
        message?: string;
        files?: string[];
    } | null> {
        try {
            const content = await fs.promises.readFile(logFile, 'utf-8');
            
            // Stage-specific pattern matching
            switch (stage) {
                case 'review': {
                    // Look for "### Review Result: APPROVED" or "### Review Result: CHANGES_REQUESTED"
                    const reviewMatch = content.match(/###\s*Review\s*Result:\s*(APPROVED|CHANGES_REQUESTED)/i);
                    if (reviewMatch) {
                        const result = reviewMatch[1].toLowerCase();
                        
                        // Try to extract feedback for changes_requested
                        let message: string | undefined;
                        if (result === 'changes_requested') {
                            // Look for "#### Issues Found" section
                            const issuesMatch = content.match(/####\s*Issues\s*Found[\s\S]*?(?=####|$)/i);
                            if (issuesMatch) {
                                message = issuesMatch[0].trim().substring(0, 500); // Limit length
                            }
                        }
                        
                        this.log(`  📋 Extracted review result from output: ${result}`);
                        return { result, message };
                    }
                    break;
                }
                
                case 'implementation': {
                    // For implementation, look for success indicators
                    // Pattern: "✓" success markers, "Implementation complete", "files modified", etc.
                    const successPatterns = [
                        /implementation\s+complete/i,
                        /successfully\s+implemented/i,
                        /✓.*(?:complete|done|finished)/i,
                        /files?\s+(?:modified|created|updated)/i
                    ];
                    
                    for (const pattern of successPatterns) {
                        if (pattern.test(content)) {
                            // Try to extract modified files
                            const filesMatch = content.match(/(?:modified|created|updated|changed).*?:\s*([^\n]+)/gi);
                            const files: string[] = [];
                            if (filesMatch) {
                                for (const match of filesMatch) {
                                    const fileNames = match.match(/[\w\-./\\]+\.\w+/g);
                                    if (fileNames) {
                                        files.push(...fileNames);
                                    }
                                }
                            }
                            
                            this.log(`  📋 Extracted implementation success from output patterns`);
                            return { result: 'success', files: files.length > 0 ? files : undefined };
                        }
                    }
                    break;
                }
                
                case 'analysis': {
                    // Look for analyst verdict patterns
                    const analysisMatch = content.match(/(?:verdict|result):\s*(pass|critical|minor)/i);
                    if (analysisMatch) {
                        this.log(`  📋 Extracted analysis result from output: ${analysisMatch[1]}`);
                        return { result: analysisMatch[1].toLowerCase() };
                    }
                    break;
                }
                
                case 'fix': {
                    // For error fix, look for success indicators
                    const fixPatterns = [
                        /fix\s+(?:applied|complete|successful)/i,
                        /error\s+(?:resolved|fixed)/i,
                        /✓.*fix/i
                    ];
                    
                    for (const pattern of fixPatterns) {
                        if (pattern.test(content)) {
                            this.log(`  📋 Extracted fix success from output patterns`);
                            return { result: 'success' };
                        }
                    }
                    break;
                }
                
                // Other stages: no specific patterns, return null
                default:
                    break;
            }
            
            return null;
        } catch (error) {
            this.log(`  ⚠️ Could not read log for output extraction: ${error}`);
            return null;
        }
    }
    
    
    /**
     * Inject task summary instructions into the agent prompt
     * 
     * Agents are asked to write a structured summary at the end of their work.
     * The workflow system will parse this summary after the agent exits to
     * determine the result - agents do NOT need to call any CLI commands.
     * 
     * @param prompt The original prompt
     * @param stage The agent stage
     * @param roleId The role ID
     * @param taskId Optional task ID for parallel task support
     */
    private injectSummaryInstructions(
        prompt: string,
        stage: AgentStage,
        roleId: string,
        taskId?: string
    ): string {
        // Get stage-specific result options
        const { resultOptions } = this.getStageCallbackInfo(stage, taskId);
        
        // Use first concrete example from examples section
        const exampleResult = resultOptions[0] || 'success';
        
        // Instructions for writing task summary - NO CLI callback required
        const summaryInstructions = `

---

## 📝 WHEN YOU FINISH - WRITE YOUR SUMMARY

When you have completed the task above, output a summary in this EXACT format:

\`\`\`
===TASK_SUMMARY_START===
RESULT: ${resultOptions.join(' | ')}
MESSAGE: Brief description of what was done or what went wrong
FILES: comma-separated list of modified files (or "none")
===TASK_SUMMARY_END===
\`\`\`

Example:
\`\`\`
===TASK_SUMMARY_START===
RESULT: ${exampleResult}
MESSAGE: Implemented the requested feature successfully
FILES: Assets/Scripts/Example.cs, Assets/Scripts/Helper.cs
===TASK_SUMMARY_END===
\`\`\`

### Result Options: ${resultOptions.map(r => `\`${r}\``).join(', ')}

**That's it!** Just write this summary when you're done. The workflow system will automatically detect your completion.
`;

        return prompt + summaryInstructions;
    }
    
    /**
     * Get stage-specific callback information for prompt injection
     * 
     * @param stage The agent stage
     * @param taskId Optional task ID for parallel task support
     */
    private getStageCallbackInfo(stage: AgentStage, taskId?: string): {
        resultOptions: string[];
        payloadSchema: string;
        examples: string;
    } {
        // Include --task parameter in examples if taskId is provided
        const taskParam = taskId ? ` --task ${taskId}` : '';
        // Use absolute path to apc CLI
        const apc = this.apcCommand;
        
        switch (stage) {
            case 'implementation':
                return {
                    resultOptions: ['success', 'failed'],
                    payloadSchema: `{
  "files": ["path/to/modified/file1.cs", "path/to/file2.cs"],
  "message": "Optional description of what was done"
}`,
                    examples: `
# Success with modified files
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage implementation${taskParam} --result success --data '{"files":["Assets/Scripts/Player.cs","Assets/Scripts/Enemy.cs"]}'

# Failed with error
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage implementation${taskParam} --result failed --data '{"error":"Could not find the specified interface to implement"}'
`
                };
                
            case 'review':
                return {
                    resultOptions: ['approved', 'changes_requested'],
                    payloadSchema: `{
  "feedback": "Description of issues found (if changes requested)",
  "files": ["paths to files that need changes"]
}`,
                    examples: `
# Approved
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage review${taskParam} --result approved --data '{}'

# Changes requested
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage review${taskParam} --result changes_requested --data '{"feedback":"Missing null checks in ProcessInput method","files":["Assets/Scripts/InputHandler.cs"]}'
`
                };
                
            case 'analysis':
                return {
                    resultOptions: ['pass', 'critical', 'minor'],
                    payloadSchema: `{
  "issues": ["Critical issue 1", "Critical issue 2"],
  "suggestions": ["Minor suggestion 1", "Minor suggestion 2"]
}`,
                    examples: `
# Pass
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage analysis${taskParam} --result pass --data '{"suggestions":["Consider adding unit tests"]}'

# Critical issues
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage analysis${taskParam} --result critical --data '{"issues":["Plan misses authentication requirement","No error handling strategy"]}'
`
                };
                
            case 'error_analysis':
                return {
                    resultOptions: ['complete'],
                    payloadSchema: `{
  "rootCause": "Description of what caused the error",
  "affectedFiles": ["path/to/affected/file.cs"],
  "suggestedFix": "How to fix the error",
  "relatedTask": "T1" // Optional: related task ID
}`,
                    examples: `
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage error_analysis${taskParam} --result complete --data '{"rootCause":"Missing using directive for UnityEngine.UI","affectedFiles":["Assets/Scripts/UI/MenuController.cs"],"suggestedFix":"Add using UnityEngine.UI at the top of the file"}'
`
                };
                
            case 'context':
            case 'delta_context':
                return {
                    resultOptions: ['success', 'failed'],
                    payloadSchema: `{
  "briefPath": "path/to/context_brief.md",
  "message": "Optional summary"
}`,
                    examples: `
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage ${stage}${taskParam} --result success --data '{"briefPath":"_AiDevLog/Context/task_context_T1.md"}'
`
                };
                
            case 'finalize':
                return {
                    resultOptions: ['success', 'failed'],
                    payloadSchema: `{
  "message": "Summary of finalization"
}`,
                    examples: `
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage finalize${taskParam} --result success --data '{"message":"Plan finalized and saved"}'
`
                };
                
            default:
                // Generic fallback for custom stages
                return {
                    resultOptions: ['success', 'failed', 'complete'],
                    payloadSchema: `{
  "message": "Description of what was done",
  "error": "Error message if failed"
}`,
                    examples: `
${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage ${stage}${taskParam} --result success --data '{"message":"Task completed"}'
`
                };
        }
    }
    
    /**
     * Helper to check if an agent result indicates success
     */
    protected isAgentSuccess(result: AgentTaskResult): boolean {
        if (!result.success) return false;
        
        // These results indicate success
        const successResults: AgentStageResult[] = ['success', 'approved', 'pass', 'complete'];
        return successResults.includes(result.result);
    }
    
    /**
     * Helper to check if an agent result indicates changes are needed
     */
    protected isAgentChangesRequested(result: AgentTaskResult): boolean {
        return result.result === 'changes_requested' || result.result === 'minor';
    }
    
    /**
     * Helper to check if an agent result indicates critical issues
     */
    protected isAgentCritical(result: AgentTaskResult): boolean {
        return result.result === 'critical' || result.result === 'failed';
    }
    
    // ========================================================================
    // Task Occupancy/Conflict Helpers (for subclasses)
    // ========================================================================
    
    /**
     * Declare task occupancy - tells coordinator this workflow is working on these tasks
     * 
     * @param taskIds Tasks to occupy
     * @param type 'exclusive' (no other workflow can work on these) or 'shared' (read-only)
     * @param reason Optional reason for logging/UI
     */
    protected declareTaskOccupancy(
        taskIds: string[], 
        type: 'exclusive' | 'shared' = 'exclusive',
        reason?: string
    ): void {
        // Add to occupied list
        for (const taskId of taskIds) {
            if (!this.occupiedTaskIds.includes(taskId)) {
                this.occupiedTaskIds.push(taskId);
            }
        }
        
        this.log(`Declaring occupancy: ${taskIds.join(', ')} (${type})`);
        
        // Fire event for coordinator
        this.onTaskOccupancyDeclared.fire({
            taskIds,
            type,
            reason
        });
    }
    
    /**
     * Release task occupancy - tells coordinator this workflow is done with these tasks
     * 
     * @param taskIds Tasks to release (or all if not specified)
     */
    protected releaseTaskOccupancy(taskIds?: string[]): void {
        const toRelease = taskIds || [...this.occupiedTaskIds];
        
        // Remove from occupied list
        this.occupiedTaskIds = this.occupiedTaskIds.filter(id => !toRelease.includes(id));
        
        if (toRelease.length > 0) {
            this.log(`Releasing occupancy: ${toRelease.join(', ')}`);
            
            // Fire event for coordinator
            this.onTaskOccupancyReleased.fire(toRelease);
        }
    }
    
    /**
     * Declare task conflicts - tells coordinator these tasks should be cancelled
     * 
     * Use this when your workflow needs exclusive access to certain tasks,
     * e.g., revision workflow declares conflicts with affected tasks.
     * 
     * @param taskIds Tasks that conflict with this workflow
     * @param resolution How coordinator should handle: cancel_others, wait_for_others, abort_if_occupied
     * @param reason Optional reason for logging/UI
     */
    protected declareTaskConflicts(
        taskIds: string[],
        resolution: 'cancel_others' | 'wait_for_others' | 'abort_if_occupied' = 'cancel_others',
        reason?: string
    ): void {
        // Store for getConflictingTaskIds()
        this.conflictingTaskIds = [...new Set([...this.conflictingTaskIds, ...taskIds])];
        
        this.log(`Declaring conflicts: ${taskIds.join(', ')} (${resolution})`);
        
        // Fire event for coordinator
        this.onTaskConflictDeclared.fire({
            taskIds,
            resolution,
            reason
        });
    }
    
    /**
     * Clear declared conflicts (e.g., after revision completes)
     */
    protected clearTaskConflicts(): void {
        if (this.conflictingTaskIds.length > 0) {
            this.log(`Clearing conflicts: ${this.conflictingTaskIds.join(', ')}`);
            this.conflictingTaskIds = [];
        }
    }
    
    // ========================================================================
    // Workflow Events (for UI interaction)
    // ========================================================================
    
    /**
     * Emit a workflow event to connected clients
     * Used for things like implementation review requests that need user interaction
     * 
     * @param eventType Event type (e.g., 'implementation_review.request')
     * @param payload Event payload
     */
    protected emitWorkflowEvent(eventType: string, payload?: any): void {
        this.log(`Emitting workflow event: ${eventType}`);
        this.onWorkflowEvent.fire({ eventType, payload });
    }
    
    /**
     * Wait for a workflow event response
     * Used to pause workflow execution until user responds to a request
     * 
     * @param eventType Event type to wait for (e.g., 'implementation_review.response')
     * @param timeoutMs Timeout in milliseconds (default 30 minutes)
     * @returns Promise that resolves with the event payload
     */
    protected waitForWorkflowEvent(eventType: string, timeoutMs: number = 30 * 60 * 1000): Promise<any> {
        this.log(`Waiting for workflow event: ${eventType} (timeout: ${timeoutMs}ms)`);
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingEventWaiters.delete(eventType);
                this.log(`Timeout waiting for event: ${eventType}`);
                resolve(null);  // Resolve with null on timeout (not reject)
            }, timeoutMs);
            
            this.pendingEventWaiters.set(eventType, {
                resolve: (value: any) => {
                    clearTimeout(timeoutId);
                    this.pendingEventWaiters.delete(eventType);
                    resolve(value);
                },
                reject: (error: Error) => {
                    clearTimeout(timeoutId);
                    this.pendingEventWaiters.delete(eventType);
                    reject(error);
                },
                timeoutId
            });
        });
    }
    
    /**
     * Handle an incoming workflow event response
     * Called by coordinator when it receives a response from a client
     * 
     * @param eventType The event type
     * @param payload The response payload
     */
    public handleWorkflowEventResponse(eventType: string, payload: any): void {
        const waiter = this.pendingEventWaiters.get(eventType);
        if (waiter) {
            this.log(`Received event response: ${eventType}`);
            waiter.resolve(payload);
        } else {
            this.log(`Received event response for non-waiting event: ${eventType}`);
        }
    }
}

