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
import { StateManager } from '../StateManager';
import { AgentPoolService } from '../AgentPoolService';
import { AgentRoleRegistry } from '../AgentRoleRegistry';
import { UnityControlManager } from '../UnityControlManager';
import { OutputChannelManager } from '../OutputChannelManager';
import { ProcessManager, ProcessState } from '../ProcessManager';
import { ServiceLocator } from '../ServiceLocator';
import { Logger } from '../../utils/Logger';
import { TaskManager, ActiveWorkflowState } from '../TaskManager';

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
    
    // Pause/resume control
    private pauseRequested: boolean = false;
    private pausePromise: Promise<void> | null = null;
    private pauseResolve: (() => void) | null = null;
    
    // Agent waiting state
    protected waitingForAgent: boolean = false;
    protected waitingForAgentRole: string | undefined;
    
    // Track if workflow has started running (becomes true after first agent allocation)
    private hasStartedRunning: boolean = false;
    
    // ========================================================================
    // Events (from IWorkflow)
    // ========================================================================
    
    readonly onProgress = new TypedEventEmitter<WorkflowProgress>();
    readonly onComplete = new TypedEventEmitter<WorkflowResult>();
    readonly onError = new TypedEventEmitter<Error>();
    readonly onAgentNeeded = new TypedEventEmitter<AgentRequest>();
    readonly onAgentReleased = new TypedEventEmitter<string>();
    readonly onAgentDemotedToBench = new TypedEventEmitter<string>();
    readonly onAgentTerminated = new TypedEventEmitter<{
        agentName: string;
        runId: string;
        reason: 'external_kill' | 'timeout' | 'error' | 'health_check_failed';
        phase?: string;
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
    // Agent Tracking (for pause/resume)
    // ========================================================================
    
    /** Current agent run ID (if an agent is actively running) */
    protected currentAgentRunId: string | undefined;
    
    /** Saved continuation context from a paused agent */
    protected continuationContext: {
        phaseName: string;
        partialOutput: string;
        filesModified: string[];
        whatWasDone: string;
    } | undefined;
    
    /** Whether pause should force-kill the agent vs wait for phase boundary */
    private forcePauseRequested: boolean = false;
    
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
            
            this.status = 'completed';
            const result: WorkflowResult = {
                success: true,
                output: this.getOutput(),
                duration: Date.now() - this.startTime
            };
            
            this.log(`Workflow completed successfully`);
            
            // Clear persisted state on successful completion
            this.clearPersistedState();
            
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
            
            // Clear persisted state on failure (no point resuming a failed workflow)
            this.clearPersistedState();
            
            this.onError.fire(error instanceof Error ? error : new Error(errorMessage));
            this.onComplete.fire(result);
            return result;
            
        } finally {
            // Release all allocated agents
            await this.releaseAllAgents();
        }
    }
    
    /**
     * Pause the workflow
     * 
     * @param options.force If true, immediately kill any running agent and save state.
     *                      If false (default), pause happens at next phase boundary.
     * @param options.reason Why the workflow is being paused (for persistence)
     */
    async pause(options?: { 
        force?: boolean; 
        reason?: 'user_request' | 'conflict' | 'error' | 'timeout' | 'daemon_shutdown';
    }): Promise<void> {
        // Allow pausing workflows in pending, running, or blocked states
        if (this.status !== 'pending' && this.status !== 'running' && this.status !== 'blocked') {
            return;
        }
        
        const force = options?.force ?? false;
        const reason = options?.reason ?? 'user_request';
        this.log(`Pause requested (force: ${force}, reason: ${reason})`);
        this.pauseRequested = true;
        this.forcePauseRequested = force;
        
        // If force pause and an agent is running, kill it and save state
        if (force && this.currentAgentRunId) {
            await this.forceKillCurrentAgent();
        }
        
        // Release task occupancy when paused (coordinator can reassign)
        // Store the IDs so we can re-acquire on resume
        if (this.occupiedTaskIds.length > 0) {
            this.log(`Releasing ${this.occupiedTaskIds.length} task occupancies on pause`);
            this.releaseTaskOccupancy([...this.occupiedTaskIds]);
        }
        
        // Create a promise that will be resolved when resume is called
        this.pausePromise = new Promise((resolve) => {
            this.pauseResolve = resolve;
        });
        
        this.status = 'paused';
        
        // Persist state to disk for cross-restart recovery
        await this.persistState(reason);
        
        this.emitProgress();
    }
    
    /**
     * Force kill the current agent and save continuation context
     */
    private async forceKillCurrentAgent(): Promise<void> {
        if (!this.currentAgentRunId) return;
        
        const { AgentRunner } = await import('../AgentBackend');
        const agentRunner = ServiceLocator.resolve(AgentRunner);
        
        // Get partial output before killing (method only available on underlying CursorAgentRunner)
        const partialOutput = (agentRunner as any).getPartialOutput?.(this.currentAgentRunId) || '';
        
        // Kill the agent
        const killed = await agentRunner.stop(this.currentAgentRunId);
        
        if (killed) {
            this.log(`Force-killed agent ${this.currentAgentRunId}`);
            
            // Save continuation context
            const phases = this.getPhases();
            this.continuationContext = {
                phaseName: phases[this.phaseIndex] || 'unknown',
                partialOutput,
                filesModified: this.extractFilesFromPartialOutput(partialOutput),
                whatWasDone: this.analyzePartialProgress(partialOutput)
            };
            
            this.log(`Saved continuation context (${partialOutput.length} chars of output)`);
        }
        
        this.currentAgentRunId = undefined;
    }
    
    /**
     * Extract files modified from partial agent output
     */
    private extractFilesFromPartialOutput(output: string): string[] {
        const files: string[] = [];
        
        // Look for FILES_MODIFIED section
        const filesMatch = output.match(/FILES_MODIFIED:[\s\S]*?(?=```|$)/i);
        if (filesMatch) {
            const lines = filesMatch[0].split('\n').filter(l => l.trim().startsWith('-'));
            for (const line of lines) {
                const file = line.replace(/^-\s*/, '').trim();
                if (file && file.includes('.')) {
                    files.push(file);
                }
            }
        }
        
        // Look for common file modification patterns
        const patterns = [
            /(?:Creating|Writing|Editing|Modifying)\s+[`"]?([^\s`"]+\.\w+)[`"]?/gi,
            /(?:created|wrote|edited|modified)\s+[`"]?([^\s`"]+\.\w+)[`"]?/gi
        ];
        
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(output)) !== null) {
                if (!files.includes(match[1])) {
                    files.push(match[1]);
                }
            }
        }
        
        return files;
    }
    
    /**
     * Analyze partial output to understand what was done
     */
    private analyzePartialProgress(output: string): string {
        const indicators: string[] = [];
        
        // Look for success indicators
        const lines = output.split('\n');
        for (const line of lines) {
            if (line.includes('✓') || line.includes('✅') || 
                line.includes('Done') || line.includes('Completed') ||
                line.includes('Created') || line.includes('Wrote')) {
                const trimmed = line.trim();
                if (trimmed.length > 10 && trimmed.length < 200) {
                    indicators.push(trimmed);
                }
            }
        }
        
        if (indicators.length > 0) {
            return indicators.slice(-5).join('\n');
        }
        
        return 'Progress unknown - review files and partial output';
    }
    
    async resume(): Promise<void> {
        if (this.status !== 'paused') {
            return;
        }
        
        this.log(`Resuming`);
        this.pauseRequested = false;
        this.forcePauseRequested = false;
        
        // Clear persisted state when resuming - workflow is no longer paused
        // If it pauses again later, a new checkpoint will be saved
        this.clearPersistedState();
        
        // If we already have agents allocated, set status to running immediately
        // Otherwise, status will change to running when first agent is allocated
        if (this.allocatedAgents.length > 0) {
            this.status = 'running';
            this.hasStartedRunning = true;
            this.log(`Resuming with ${this.allocatedAgents.length} allocated agents`);
        } else {
            this.log(`Resuming - will change to running when agent is allocated`);
        }
        
        this.emitProgress();
        
        // Log continuation context if we have it
        if (this.continuationContext) {
            this.log(`Continuation context available from phase: ${this.continuationContext.phaseName}`);
            this.log(`Files modified before pause: ${this.continuationContext.filesModified.join(', ') || 'none'}`);
        }
        
        // Resolve the pause promise to continue execution
        if (this.pauseResolve) {
            this.pauseResolve();
            this.pauseResolve = null;
            this.pausePromise = null;
        }
    }
    
    /**
     * Get continuation context if we were force-paused mid-agent
     * Subclasses can use this to prepend to the next agent prompt
     */
    protected getContinuationPrompt(): string | undefined {
        if (!this.continuationContext) return undefined;
        
        const ctx = this.continuationContext;
        
        return `## ⚠️ SESSION CONTINUATION

This task was paused mid-execution. You are continuing where the previous agent left off.

### Phase When Paused: ${ctx.phaseName}

### Files Modified Before Pause
${ctx.filesModified.length > 0 ? ctx.filesModified.map(f => `- ${f}`).join('\n') : '- None yet'}

### What Was Done
${ctx.whatWasDone}

### Important Instructions
1. **DO NOT** redo work that appears to be complete (check the files!)
2. Review the partial output below for context
3. Continue the task from where it stopped

### Partial Output From Previous Agent
\`\`\`
${ctx.partialOutput.slice(-3000)}
\`\`\`

---

`;
    }
    
    /**
     * Clear continuation context after it's been used
     */
    protected clearContinuationContext(): void {
        this.continuationContext = undefined;
    }
    
    async cancel(): Promise<void> {
        this.log(`Cancelling`);
        this.status = 'cancelled';
        this.emitProgress();
        
        // Release pause if paused
        if (this.pauseResolve) {
            this.pauseResolve();
        }
        
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
        
        // CRITICAL: Clear persisted state on cancel to prevent ghost workflows on restart
        // Without this, cancelled workflows would be restored as paused on daemon restart
        this.clearPersistedState();
        
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
    
    // ========================================================================
    // State Restoration (for recovery after extension restart)
    // ========================================================================
    
    /**
     * Restore workflow state from saved state
     * Used during session recovery to set workflow back to its paused position
     * 
     * @param savedState State from task.activeWorkflow (persisted in tasks.json)
     */
    restoreFromSavedState(savedState: {
        phaseIndex: number;
        phaseName?: string;
        phaseProgress?: 'not_started' | 'in_progress' | 'completed';
        filesModified?: string[];
        continuationContext?: {
            phaseName: string;
            partialOutput: string;
            filesModified: string[];
            whatWasDone: string;
        };
    }): void {
        // Restore phase progress
        this.phaseIndex = savedState.phaseIndex;
        this.status = 'paused';
        
        // Restore continuation context if we were mid-agent
        if (savedState.continuationContext) {
            this.continuationContext = savedState.continuationContext;
        }
        
        this.log(`Restored state: phase ${savedState.phaseIndex} (${savedState.phaseName || 'unknown'})`);
        
        // Emit progress to notify UI
        this.emitProgress();
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
    
    /**
     * Persist workflow state to disk for cross-restart recovery
     * 
     * Called:
     * - When workflow is paused (user_request, conflict, daemon_shutdown)
     * - After each phase completion (checkpoint)
     * 
     * The saved state includes everything needed to:
     * - Recreate the workflow object on daemon restart
     * - Resume from the correct phase
     * - Restore agent allocations
     * 
     * @param reason Why the state is being saved
     */
    async persistState(reason: 'user_request' | 'conflict' | 'error' | 'timeout' | 'daemon_shutdown' | 'checkpoint'): Promise<void> {
        const phases = this.getPhases();
        const phaseName = phases[this.phaseIndex] || 'unknown';
        
        // Get taskId from input - only task_implementation workflows have this
        const taskId = (this.input as any).taskId;
        if (!taskId) {
            // Non-task workflows (like planning workflows) don't persist to tasks
            this.log(`Skipping persist for non-task workflow (reason: ${reason})`);
            return;
        }
        
        // Build workflow status for persistence
        let workflowStatus: ActiveWorkflowState['status'] = 'running';
        if (this.status === 'paused') {
            workflowStatus = 'paused';
        } else if (this.status === 'blocked') {
            workflowStatus = 'blocked';
        } else if (this.status === 'pending') {
            workflowStatus = 'pending';
        }
        
        // Build continuation context if we have partial work
        const continuationContext = this.continuationContext ? {
            partialOutput: this.continuationContext.partialOutput || '',
            filesModified: this.continuationContext.filesModified || [],
            whatWasDone: this.continuationContext.whatWasDone || 
                (this.phaseIndex > 0 ? `Completed phases: ${phases.slice(0, this.phaseIndex).join(', ')}` : 'Just started')
        } : undefined;
        
        // Build the active workflow state to persist
        const activeWorkflowState: Partial<ActiveWorkflowState> = {
            status: workflowStatus,
            phaseIndex: this.phaseIndex,
            phaseName,
            allocatedAgents: this.getAllocatedAgentNames(),
            pausedAt: new Date().toISOString(),
            continuationContext
        };
        
        // Save to task via TaskManager
        // taskId should already be in global format PS_XXXXXX_TN - just normalize to uppercase
        const globalTaskId = taskId.toUpperCase();
        const taskManager = ServiceLocator.resolve(TaskManager);
        taskManager.saveActiveWorkflowState(globalTaskId, activeWorkflowState);
        this.log(`Persisted state (reason: ${reason}, phase: ${this.phaseIndex}/${phases.length})`);
    }
    
    /**
     * Build continuation prompt from saved context
     */
    private buildContinuationPromptFromContext(): string {
        if (!this.continuationContext) return '';
        
        const lines: string[] = [
            '## ⚠️ SESSION CONTINUATION',
            '',
            'This task was paused mid-execution. You are continuing from where the previous agent left off.',
            '',
            `### Phase: ${this.continuationContext.phaseName}`,
            '',
            '### What Was Done',
            this.continuationContext.whatWasDone || 'Unknown - check files modified',
            '',
            '### Files Modified So Far',
            this.continuationContext.filesModified.length > 0 
                ? this.continuationContext.filesModified.map(f => `- ${f}`).join('\n')
                : '- None yet',
            '',
            '### Instructions',
            'Continue the work from where the previous agent left off. Do not repeat completed work.',
            ''
        ];
        
        return lines.join('\n');
    }
    
    /**
     * Clear persisted state (called after successful completion or cancellation)
     */
    clearPersistedState(): void {
        const taskId = (this.input as any).taskId;
        if (!taskId) {
            // Non-task workflows don't have persisted state in tasks
            return;
        }
        
        // taskId should already be in global format PS_XXXXXX_TN - just normalize to uppercase
        const globalTaskId = taskId.toUpperCase();
        const taskManager = ServiceLocator.resolve(TaskManager);
        taskManager.clearActiveWorkflow(globalTaskId);
        this.log('Cleared persisted state');
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
        
        // Clear continuation context (memory cleanup)
        // Explicitly release large strings
        if (this.continuationContext) {
            this.continuationContext.partialOutput = '';
            this.continuationContext.filesModified = [];
            this.continuationContext.whatWasDone = '';
            this.continuationContext = undefined;
        }
        this.currentAgentRunId = undefined;
        
        // Clear pause state
        this.pauseRequested = false;
        this.forcePauseRequested = false;
        if (this.pauseResolve) {
            // Resolve any pending pause to prevent hanging promises
            this.pauseResolve();
        }
        this.pausePromise = null;
        this.pauseResolve = null;
        
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
        this.onTaskOccupancyDeclared.dispose();
        this.onTaskOccupancyReleased.dispose();
        this.onTaskConflictDeclared.dispose();
        
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
            
            // Check for pause
            if (this.pauseRequested && this.pausePromise) {
                this.log(`Paused at phase ${this.phaseIndex}: ${phases[this.phaseIndex]}`);
                await this.pausePromise;
                
                // Check if cancelled during pause (use local var due to TS narrowing)
                const pauseStatus: WorkflowStatus = this.status;
                if (pauseStatus === 'cancelled') {
                    return;
                }
            }
            
            this.log(`Phase ${this.phaseIndex + 1}/${phases.length}: ${phases[this.phaseIndex]}`);
            this.emitProgress();
            
            // Execute phase with retry support
            await this.executePhaseWithRetry(this.phaseIndex);
            this.phaseIndex++;
            
            // Checkpoint after each phase completion (for cross-restart recovery)
            // Don't persist if we're about to complete (no more phases)
            if (this.phaseIndex < phases.length) {
                await this.persistState('checkpoint');
            }
        }
    }
    
    /**
     * Execute a phase with retry logic
     * 
     * Uses exponential backoff with configurable retry settings.
     * Subclasses can override getRetryPolicy() to customize retry behavior.
     */
    protected async executePhaseWithRetry(phaseIndex: number): Promise<void> {
        const { RetryPolicy } = await import('./RetryPolicy');
        const { ErrorClassifier } = await import('./ErrorClassifier');
        
        const policy = new RetryPolicy(this.type);
        const classifier = ServiceLocator.resolve(ErrorClassifier);
        const phases = this.getPhases();
        const phaseName = phases[phaseIndex];
        
        while (true) {
            try {
                await this.executePhase(phaseIndex);
                policy.recordSuccess();
                return; // Success!
                
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const decision = policy.recordFailure(errorMessage);
                const classification = classifier.classify(errorMessage);
                
                this.log(`Phase ${phaseName} failed: ${errorMessage.substring(0, 100)}`);
                this.log(`  Error type: ${classification.type} (${classification.category})`);
                this.log(`  Attempt: ${policy.getAttemptCount()}/${policy.getMaxAttempts()}`);
                
                if (!decision.shouldRetry) {
                    // No more retries - propagate the error
                    this.log(`  ❌ Giving up: ${decision.reason}`);
                    throw error;
                }
                
                // Cancel any pending completion signals before retry
                // This prevents "Already waiting for completion signal" errors when
                // retrying phases that spawn agents with waitForAgentCompletion
                try {
                    const { UnifiedCoordinatorService } = await import('../UnifiedCoordinatorService');
                    const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
                    coordinator.cancelPendingSignal(this.id);
                    this.log(`  🧹 Cleared pending completion signals for retry`);
                } catch (cleanupError) {
                    // Non-fatal: just log and continue
                    this.log(`  ⚠️ Failed to clear pending signals: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
                }
                
                // Wait before retry
                this.log(`  🔄 Retrying in ${Math.round(decision.delayMs / 1000)}s...`);
                await RetryPolicy.delay(decision.delayMs);
                
                // Check for cancellation/pause before retry
                const statusBeforeRetry: WorkflowStatus = this.status;
                if (statusBeforeRetry === 'cancelled') {
                    throw new Error('Workflow cancelled during retry');
                }
                
                if (this.pauseRequested && this.pausePromise) {
                    this.log(`  ⏸️ Paused during retry`);
                    await this.pausePromise;
                    
                    const statusAfterPause: WorkflowStatus = this.status;
                    if (statusAfterPause === 'cancelled') {
                        throw new Error('Workflow cancelled during retry pause');
                    }
                }
            }
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
    
    // ========================================================================
    // Agent Task Execution with CLI Callback Support
    // ========================================================================
    
    /**
     * Run an agent task and wait for CLI callback or process completion
     * 
     * This is the primary method for running agent tasks with structured results.
     * The agent MUST call `apc agent complete` to signal completion.
     * If the process exits without calling the CLI callback, the workflow fails.
     * 
     * The race works as follows:
     * 1. Start the agent process
     * 2. Wait for EITHER:
     *    a) CLI callback (`apc agent complete`) - required for success
     *    b) Process exit without callback - throws an error
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
            /** Stage name for CLI callback matching (e.g., 'implementation', 'review') */
            expectedStage: AgentStage;
            /** Timeout in milliseconds (default 10 minutes) */
            timeout?: number;
            /** Custom model to use instead of role default */
            model?: string;
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
        const { UnifiedCoordinatorService } = await import('../UnifiedCoordinatorService');
        const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
        
        const role = this.getRole(roleId);
        const timeout = options.timeout ?? role?.timeoutMs ?? 600000;
        
        this.log(`Starting agent task [${taskId}] with CLI callback (stage: ${options.expectedStage})`);
        
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
                        this.log(`  🔧 FIX: Removed ${agentName} from benchedAgents (was at index ${benchIndex})`);
                    }
                    // Add to allocatedAgents (agent is now active for this workflow)
                    if (!this.allocatedAgents.includes(agentName)) {
                        this.allocatedAgents.push(agentName);
                        this.log(`  🔧 FIX: Added ${agentName} to allocatedAgents`);
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
        
        // Inject CLI callback instructions into prompt (include taskId for parallel task support)
        const enhancedPrompt = this.injectCliCallbackInstructions(
            prompt,
            options.expectedStage,
            roleId,
            taskId
        );
        
        // Start the agent process
        const runId = `${this.id}_${taskId}_${Date.now()}`;
        this.currentAgentRunId = runId;
        
        // Set up log file for streaming - temp file with agent name
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, `${this.id}_${agentName}.log`);
        
        // Log the agent's log file as clickable file URI
        const fileUri = `file:///${logFile.replace(/\\/g, '/')}`;
        this.log(`  📋 Agent log: ${fileUri}`);
        
        const agentPromise = agentRunner.run({
            id: runId,
            prompt: enhancedPrompt,
            model: options.model ?? role?.defaultModel ?? 'sonnet-4.5',
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
        
        // IMPORTANT: The agent runner (CursorAgentRunner) already registers the process
        // with ProcessManager in its run() method via registerExternalProcess().
        // ProcessManager will now monitor the process health and call our callbacks
        // (setupProcessManagerMonitoring) if the process gets stuck or times out.
        // This provides automatic detection of external kills without duplicating logic.
        
        // Wait for CLI callback from coordinator (include taskId for parallel task support)
        const callbackPromise = coordinator.waitForAgentCompletion(
            this.id,
            options.expectedStage,
            timeout,
            taskId
        );
        
        try {
            // Race: CLI callback required, process exit without callback is an error
            const result = await Promise.race([
                callbackPromise.then(signal => ({ type: 'callback' as const, signal })),
                agentPromise.then(result => ({ type: 'process' as const, result }))
            ]);
            
            this.currentAgentRunId = undefined;
            
            if (result.type === 'callback') {
                // Clean termination via CLI callback - preferred path
                const signal = result.signal;
                this.log(`Agent [${taskId}] completed via CLI callback: ${signal.result}`);
                
                // Kill the agent process since we got the callback
                // (it should exit on its own, but just in case)
                await agentRunner.stop(runId).catch(() => {});
                
                return {
                    success: signal.result !== 'failed',
                    result: signal.result,
                    payload: signal.payload,
                    fromCallback: true
                };
                
            } else {
                // Process exited without CLI callback - NOT ALLOWED
                const processResult = result.result;
                this.log(`Agent [${taskId}] process exited without CLI callback`);
                
                // Cancel the pending callback wait (include taskId for parallel task support)
                coordinator.cancelPendingSignal(this.id, options.expectedStage, taskId);
                
                // All agents must use CLI callback for structured data
                throw new Error(
                    `Agent [${taskId}] did not use CLI callback (\`apc agent complete\`). ` +
                    'All agents must report results via CLI callback for structured data. ' +
                    'Legacy output parsing is no longer supported. ' +
                    `Process exit code: ${processResult.success ? 'success' : 'failed'}`
                );
            }
            
        } catch (error) {
            this.currentAgentRunId = undefined;
            
            // Timeout or other error (include taskId for parallel task support)
            coordinator.cancelPendingSignal(this.id, options.expectedStage, taskId);
            await agentRunner.stop(runId).catch(() => {});
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.log(`Agent [${taskId}] failed: ${errorMessage}`);
            
            // Try a nudge session before giving up - fast model just asks agent to call CLI
            // This recovers cases where agent did the work but forgot to signal completion
            if (errorMessage.includes('Timeout') || errorMessage.includes('did not use CLI callback')) {
                const nudgeResult = await this.tryCliNudgeSession(
                    taskId,
                    options.expectedStage,
                    agentName,
                    logFile,
                    options.cwd
                );
                if (nudgeResult) {
                    return nudgeResult; // Nudge succeeded!
                }
                // Nudge failed - fall through to return failure (retry system will handle it)
            }
            
            return {
                success: false,
                result: 'failed',
                payload: { error: errorMessage },
                fromCallback: false
            };
        }
        // NOTE: Agent lifecycle is managed by the caller, not here.
        // - TaskImplementationWorkflow demotes to bench (for implement→review→revise loop)
        // - ErrorResolutionWorkflow releases immediately
        // - Other workflows rely on releaseAllAgents() at workflow end
    }
    
    /**
     * Try a fast "nudge" session to get the agent to call CLI
     * 
     * When an agent does work but forgets to call CLI, this runs a quick
     * follow-up session with a fast model that just asks them to call CLI.
     * The agent reads the log file to understand what was done.
     * 
     * @param taskId The task identifier
     * @param stage The expected stage for CLI callback
     * @param agentName The agent to nudge (same Cursor window)
     * @param logFile Path to the agent's log from the previous session
     * @param cwd Working directory
     * @returns AgentTaskResult if nudge succeeded, null if failed
     */
    private async tryCliNudgeSession(
        taskId: string,
        stage: AgentStage,
        agentName: string,
        logFile: string,
        cwd?: string
    ): Promise<AgentTaskResult | null> {
        const NUDGE_TIMEOUT = 60000; // 60 seconds
        
        this.log(`\n🔔 NUDGE: Trying quick CLI completion session for ${agentName}...`);
        
        try {
            const { AgentRunner } = await import('../AgentBackend');
            const agentRunner = ServiceLocator.resolve(AgentRunner);
            const { UnifiedCoordinatorService } = await import('../UnifiedCoordinatorService');
            const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
            const { getDefaultSystemPrompt } = await import('../../types');
            
            // Get the cli_nudge prompt template from settings
            const nudgeConfig = getDefaultSystemPrompt('cli_nudge');
            if (!nudgeConfig) {
                this.log(`  ⚠️ NUDGE: No cli_nudge prompt configured, skipping`);
                return null;
            }
            
            // Build the CLI command
            const apc = this.apcCommand;
            const taskParamInline = taskId ? ` --task ${taskId}` : '';
            const { resultOptions } = this.getStageCallbackInfo(stage, taskId);
            const exampleResult = resultOptions[0] || 'success';
            const cliCommand = `${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage ${stage}${taskParamInline} --result ${exampleResult} --data '{}'`;
            
            // Inject variables into the template
            let nudgePrompt = nudgeConfig.promptTemplate || '';
            nudgePrompt = nudgePrompt.replace('{{LOG_FILE_PATH}}', logFile);
            nudgePrompt = nudgePrompt.replace('{{CLI_COMMAND}}', cliCommand);
            nudgePrompt = nudgePrompt.replace('{{RESULT_OPTIONS}}', resultOptions.map(r => `\`${r}\``).join(', '));
            
            const nudgeRunId = `${this.id}_nudge_${taskId}_${Date.now()}`;
            const nudgeLogFile = logFile.replace('.log', '_nudge.log');
            const nudgeModel = nudgeConfig.defaultModel || 'haiku-3.5';
            
            this.log(`  📋 Nudge log: file:///${nudgeLogFile.replace(/\\/g, '/')}`);
            this.log(`  🚀 Starting nudge agent (${nudgeModel})...`);
            
            // Start nudge agent
            const nudgePromise = agentRunner.run({
                id: nudgeRunId,
                prompt: nudgePrompt,
                model: nudgeModel,
                cwd: cwd ?? process.cwd(),
                logFile: nudgeLogFile,
                timeoutMs: NUDGE_TIMEOUT,
                onProgress: (msg) => this.log(`  [nudge] ${msg}`),
                metadata: {
                    roleId: 'cli_nudge',
                    coordinatorId: this.id,
                    sessionId: this.sessionId,
                    taskId: `nudge_${taskId}`,
                    agentName,
                    workflowType: this.type
                }
            });
            
            // Wait for CLI callback
            const nudgeCallbackPromise = coordinator.waitForAgentCompletion(
                this.id,
                stage,
                NUDGE_TIMEOUT,
                taskId
            );
            
            const result = await Promise.race([
                nudgeCallbackPromise.then(signal => ({ type: 'callback' as const, signal })),
                nudgePromise.then(result => ({ type: 'process' as const, result }))
            ]);
            
            if (result.type === 'callback') {
                // Success! Agent called CLI
                const signal = result.signal;
                this.log(`  ✓ NUDGE succeeded! Agent called CLI: ${signal.result}`);
                
                await agentRunner.stop(nudgeRunId).catch(() => {});
                
                return {
                    success: signal.result !== 'failed',
                    result: signal.result,
                    payload: signal.payload,
                    fromCallback: true
                };
            } else {
                // Nudge also failed - agent still didn't call CLI
                this.log(`  ✗ NUDGE failed - agent still didn't call CLI`);
                coordinator.cancelPendingSignal(this.id, stage, taskId);
                await agentRunner.stop(nudgeRunId).catch(() => {});
                return null;
            }
            
        } catch (nudgeError) {
            this.log(`  ✗ NUDGE error: ${nudgeError instanceof Error ? nudgeError.message : String(nudgeError)}`);
            return null;
        }
    }
    
    /**
     * Inject CLI callback instructions into the agent prompt
     * 
     * Uses "sandwich" technique: brief reminder at START + detailed instructions at END.
     * This ensures the AI doesn't forget to call the callback even for long tasks.
     * 
     * @param prompt The original prompt
     * @param stage The agent stage
     * @param roleId The role ID
     * @param taskId Optional task ID for parallel task support
     */
    private injectCliCallbackInstructions(
        prompt: string,
        stage: AgentStage,
        roleId: string,
        taskId?: string
    ): string {
        // Get stage-specific result options and payload schema
        const { resultOptions, payloadSchema, examples } = this.getStageCallbackInfo(stage, taskId);
        
        // Include --task parameter inline if taskId is provided (for parallel tasks)
        const taskParamInline = taskId ? ` --task ${taskId}` : '';
        
        // Get absolute path to apc CLI for reliable execution
        const apc = this.apcCommand;
        
        // Use first concrete example from examples section
        const exampleResult = resultOptions[0] || 'success';
        const exampleCommand = `${apc} agent complete --session ${this.sessionId} --workflow ${this.id} --stage ${stage}${taskParamInline} --result ${exampleResult} --data '{}'`;
        
        // Get role rules to inject
        const role = this.getRole(roleId);
        const roleRules = role?.rules || [];
        const rulesSection = roleRules.length > 0 
            ? `\n## Rules You Must Follow\n${roleRules.map(r => `- ${r}`).join('\n')}\n` 
            : '';
        
        // MANDATORY WORKFLOW HEADER - extremely prominent with immediate acknowledgment requirement
        const workflowHeader = `
╔══════════════════════════════════════════════════════════════════════════════════════╗
║  🚨🚨🚨 CRITICAL: YOU MUST RUN A CLI COMMAND TO COMPLETE - WORKFLOW FAILS WITHOUT IT 🚨🚨🚨  ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

## ⚡ IMMEDIATE ACTION REQUIRED

Before doing ANY work, acknowledge this requirement by thinking: "I must run the apc agent complete command when done."

Your REQUIRED completion command (run this when your work is finished):
\`\`\`bash
${exampleCommand}
\`\`\`

## YOUR WORKFLOW

1. **DO**: Complete the task described below
2. **THEN**: Run the command above in the terminal (use run_terminal_cmd tool)  
3. **VERIFY**: The command outputs success before finishing

❌ **FAILURE MODE**: Exiting without running the command = WORKFLOW FAILS
✅ **SUCCESS MODE**: Task complete + CLI command run successfully = WORKFLOW SUCCEEDS
${rulesSection}
---

`;
        
        // MID-PROMPT REMINDER - inserted after main task
        const midPromptReminder = `

---
🔔 **REMINDER**: When you finish the task above, you MUST run this command:
\`\`\`bash
${exampleCommand}
\`\`\`
---

`;
        
        // DETAILED INSTRUCTIONS at END - reinforcement
        const callbackInstructions = `

---

## 📡 FINAL STEP: RUN THE COMPLETION COMMAND (MANDATORY)

You have completed the work above. Now you MUST run the completion command using the \`run_terminal_cmd\` tool.

### ⛔ STOP - DO NOT FINISH WITHOUT RUNNING THIS COMMAND

The workflow system is actively waiting for this CLI callback signal. Your text responses are NOT sufficient.
You must execute this terminal command:

\`\`\`bash
${exampleCommand}
\`\`\`

### Result Options: ${resultOptions.map(r => `\`${r}\``).join(', ')}

### Payload Schema (for --data parameter)
\`\`\`json
${payloadSchema}
\`\`\`

### Complete Examples
${examples}

### Troubleshooting
- If command fails: Wait 2 seconds and retry (up to 3 times)
- Check daemon status: \`${apc} status\`

### ✅ FINAL CHECKLIST - ALL MUST BE TRUE
- [ ] I completed my assigned work  
- [ ] I ran the \`${apc} agent complete\` command using run_terminal_cmd
- [ ] The command returned successfully (exit code 0)

🛑 **YOUR RESPONSE IS NOT COMPLETE UNTIL YOU RUN THE CLI COMMAND** 🛑
`;

        return workflowHeader + prompt + midPromptReminder + callbackInstructions;
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
     * Declare task conflicts - tells coordinator these tasks should be paused
     * 
     * Use this when your workflow needs exclusive access to certain tasks,
     * e.g., revision workflow declares conflicts with affected tasks.
     * 
     * @param taskIds Tasks that conflict with this workflow
     * @param resolution How coordinator should handle: pause_others, wait_for_others, abort_if_occupied
     * @param reason Optional reason for logging/UI
     */
    protected declareTaskConflicts(
        taskIds: string[],
        resolution: 'pause_others' | 'wait_for_others' | 'abort_if_occupied' = 'pause_others',
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
}

