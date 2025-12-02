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
import { ServiceLocator } from '../ServiceLocator';

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
    /** Raw output from the agent (only if process exited without CLI callback - legacy fallback) */
    rawOutput?: string;
    /** Whether this result came from CLI callback (true) or process exit (false/legacy) */
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
    protected phaseIndex: number = 0;
    protected startTime: number = 0;
    protected allocatedAgents: string[] = [];
    protected input: Record<string, any>;
    protected priority: number;
    
    // Pause/resume control
    private pauseRequested: boolean = false;
    private pausePromise: Promise<void> | null = null;
    private pauseResolve: (() => void) | null = null;
    
    // ========================================================================
    // Events (from IWorkflow)
    // ========================================================================
    
    readonly onProgress = new TypedEventEmitter<WorkflowProgress>();
    readonly onComplete = new TypedEventEmitter<WorkflowResult>();
    readonly onError = new TypedEventEmitter<Error>();
    readonly onAgentNeeded = new TypedEventEmitter<AgentRequest>();
    readonly onAgentReleased = new TypedEventEmitter<string>();
    
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
     * Get the absolute path to the apc CLI command.
     * 
     * Checks in order:
     * 1. ~/.local/bin/apc (standard install location)
     * 2. /usr/local/bin/apc (alternative location)
     * 3. Falls back to 'apc' (relies on PATH)
     * 
     * Result is cached for performance.
     */
    protected static getApcPath(): string {
        if (BaseWorkflow._apcPath !== null) {
            return BaseWorkflow._apcPath;
        }
        
        // Check standard locations
        const homeBinPath = path.join(os.homedir(), '.local', 'bin', 'apc');
        const usrLocalPath = '/usr/local/bin/apc';
        
        if (fs.existsSync(homeBinPath)) {
            BaseWorkflow._apcPath = homeBinPath;
            console.log(`[BaseWorkflow] Using apc at: ${homeBinPath}`);
            return homeBinPath;
        }
        
        if (fs.existsSync(usrLocalPath)) {
            BaseWorkflow._apcPath = usrLocalPath;
            console.log(`[BaseWorkflow] Using apc at: ${usrLocalPath}`);
            return usrLocalPath;
        }
        
        // Fall back to PATH-based lookup
        console.log('[BaseWorkflow] apc not found at standard locations, using PATH-based lookup');
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
        this.unityEnabled = services.unityEnabled;
        
        // Initialize workflow log file (persistent)
        this.initializeWorkflowLog();
    }
    
    /**
     * Initialize the persistent workflow log file
     */
    private initializeWorkflowLog(): void {
        try {
            const planFolder = this.stateManager.getPlanFolder(this.sessionId);
            if (planFolder) {
                const logDir = path.join(planFolder, 'logs');
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
            logPath: this.workflowLogPath
        };
    }
    
    // ========================================================================
    // IWorkflow Implementation - Lifecycle
    // ========================================================================
    
    async start(): Promise<WorkflowResult> {
        if (this.status !== 'pending') {
            throw new Error(`Cannot start workflow in ${this.status} state`);
        }
        
        this.status = 'running';
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
            this.onComplete.fire(result);
            return result;
            
        } catch (error) {
            this.status = 'failed';
            const errorMessage = error instanceof Error ? error.message : String(error);
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
    
    /**
     * Pause the workflow
     * 
     * @param options.force If true, immediately kill any running agent and save state.
     *                      If false (default), pause happens at next phase boundary.
     */
    async pause(options?: { force?: boolean }): Promise<void> {
        if (this.status !== 'running' && this.status !== 'blocked') {
            return;
        }
        
        const force = options?.force ?? false;
        this.log(`Pause requested (force: ${force})`);
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
        this.status = 'running';
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
     * @param savedState State saved by WorkflowPauseManager
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
    
    // ========================================================================
    // IWorkflow Implementation - Cleanup
    // ========================================================================
    
    dispose(): void {
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
        
        // Clear task tracking
        this.occupiedTaskIds = [];
        this.conflictingTaskIds = [];
        
        // Dispose event emitters (this removes all listeners)
        this.onProgress.dispose();
        this.onComplete.dispose();
        this.onError.dispose();
        this.onAgentNeeded.dispose();
        this.onAgentReleased.dispose();
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
                fs.appendFileSync(this.workflowLogPath, `[${timestamp}] ${message}\n`);
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
     * Returns a promise that resolves with the agent name when allocated
     */
    protected requestAgent(roleId: string): Promise<string> {
        return new Promise((resolve) => {
            const request: AgentRequest = {
                workflowId: this.id,
                roleId,
                priority: this.priority,
                callback: (agentName: string) => {
                    this.allocatedAgents.push(agentName);
                    this.log(`Agent allocated: ${agentName} (role: ${roleId})`);
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
        const index = this.allocatedAgents.indexOf(agentName);
        if (index >= 0) {
            this.allocatedAgents.splice(index, 1);
            this.log(`Agent released: ${agentName}`);
            console.log(`[BaseWorkflow] Firing onAgentReleased for ${agentName}`);
            this.onAgentReleased.fire(agentName);
            console.log(`[BaseWorkflow] onAgentReleased fired for ${agentName}`);
        } else {
            console.log(`[BaseWorkflow] Agent ${agentName} not in allocatedAgents, skipping release`);
        }
    }
    
    /**
     * Release all allocated agents
     */
    protected async releaseAllAgents(): Promise<void> {
        const agents = [...this.allocatedAgents];
        for (const agent of agents) {
            this.releaseAgent(agent);
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
     * The agent is expected to call `apc agent complete` to signal completion,
     * but we also handle the legacy case where the agent just exits.
     * 
     * The race works as follows:
     * 1. Start the agent process
     * 2. Wait for EITHER:
     *    a) CLI callback (`apc agent complete`) - preferred, structured
     *    b) Process exit - fallback, will use output parsing if needed
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
        }
    ): Promise<AgentTaskResult> {
        const { AgentRunner } = await import('../AgentBackend');
        const agentRunner = ServiceLocator.resolve(AgentRunner);
        const { UnifiedCoordinatorService } = await import('../UnifiedCoordinatorService');
        const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
        
        const role = this.getRole(roleId);
        const timeout = options.timeout ?? role?.timeoutMs ?? 600000;
        
        this.log(`Starting agent task [${taskId}] with CLI callback (stage: ${options.expectedStage})`);
        this.log(`  Requesting agent for role: ${roleId}...`);
        
        // Request an agent from the pool (this triggers agent.allocated event)
        const agentName = await this.requestAgent(roleId);
        this.log(`  Agent ${agentName} allocated for ${roleId}`);
        
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
        
        const agentPromise = agentRunner.run({
            id: runId,
            prompt: enhancedPrompt,
            model: options.model ?? role?.defaultModel ?? 'sonnet-4.5',
            cwd: options.cwd ?? process.cwd(),
            logFile,
            timeoutMs: timeout,
            onProgress: (msg) => this.log(`  ${msg}`),
            metadata: {
                roleId,
                coordinatorId: this.id,
                sessionId: this.sessionId,
                taskId,
                agentName
            }
        });
        
        // Wait for CLI callback from coordinator (include taskId for parallel task support)
        const callbackPromise = coordinator.waitForAgentCompletion(
            this.id,
            options.expectedStage,
            timeout,
            taskId
        );
        
        try {
            // Race: CLI callback wins, process exit is fallback
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
                // Process exited without CLI callback - legacy fallback
                const processResult = result.result;
                this.log(`Agent [${taskId}] process exited without CLI callback (legacy mode)`);
                
                // Cancel the pending callback wait (include taskId for parallel task support)
                coordinator.cancelPendingSignal(this.id, options.expectedStage, taskId);
                
                // If process failed, we treat it as failed
                if (!processResult.success) {
                    return {
                        success: false,
                        result: 'failed',
                        rawOutput: processResult.output,
                        fromCallback: false
                    };
                }
                
                // Process succeeded but no callback - return raw output for parsing
                return {
                    success: true,
                    result: 'success',
                    rawOutput: processResult.output,
                    fromCallback: false
                };
            }
            
        } catch (error) {
            this.currentAgentRunId = undefined;
            
            // Timeout or other error (include taskId for parallel task support)
            coordinator.cancelPendingSignal(this.id, options.expectedStage, taskId);
            await agentRunner.stop(runId).catch(() => {});
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.log(`Agent [${taskId}] failed: ${errorMessage}`);
            
            return {
                success: false,
                result: 'failed',
                payload: { error: errorMessage },
                fromCallback: false
            };
        } finally {
            // Always release the agent back to the pool
            this.releaseAgent(agentName);
        }
    }
    
    /**
     * Inject CLI callback instructions into the agent prompt
     * 
     * This adds standardized instructions at the end of the prompt telling
     * the agent how to signal completion via CLI.
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
        
        // Include --task parameter if taskId is provided (for parallel tasks)
        const taskParam = taskId ? `    --task ${taskId} \\\n` : '';
        
        // Get absolute path to apc CLI for reliable execution
        const apc = this.apcCommand;
        
        const callbackInstructions = `

## 📡 COMPLETION SIGNALING (REQUIRED)

When you finish your work, you MUST signal completion using the CLI callback command.
This is REQUIRED - the workflow cannot proceed without it.

### Command Format
\`\`\`bash
${apc} agent complete \\
    --session ${this.sessionId} \\
    --workflow ${this.id} \\
    --stage ${stage} \\
${taskParam}    --result <RESULT> \\
    --data '<JSON_PAYLOAD>'
\`\`\`

### Result Options for ${stage}
${resultOptions.map(r => `- \`${r}\``).join('\n')}

### Payload Schema
\`\`\`json
${payloadSchema}
\`\`\`

### Examples
${examples}

### Retry on Failure
If the command fails (e.g., network error, daemon not running):
1. Wait 2 seconds
2. Retry the command up to 3 times
3. If still failing, output the error and exit

### Important Notes
- Call this command ONCE when your work is complete
- The command will terminate your session gracefully
- Include ALL relevant data in the payload
`;

        return prompt + callbackInstructions;
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

