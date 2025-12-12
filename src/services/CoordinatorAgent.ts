// ============================================================================
// AI Coordinator Agent
// ============================================================================
//
// Event-driven AI agent that makes intelligent decisions about:
// - Which workflows to dispatch for which tasks
// - When to ask user for clarification
// - How to handle errors and blocked tasks
// - Task prioritization and agent allocation
//
// The agent receives full context (plan, history, state) and outputs
// structured decisions that the UnifiedCoordinatorService executes.

import * as fs from 'fs';
import * as path from 'path';
import { AgentRunner } from './AgentBackend';
import { OutputChannelManager } from './OutputChannelManager';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { ServiceLocator } from './ServiceLocator';
import { StateManager } from './StateManager';
import { ProcessManager } from './ProcessManager';
import { TypedEventEmitter } from './TypedEventEmitter';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import {
    CoordinatorEvent,
    CoordinatorEventType,
    CoordinatorInput,
    CoordinatorDecision,
    CoordinatorHistoryEntry,
    CoordinatorAgentConfig,
    DEFAULT_COORDINATOR_CONFIG,
    TaskSummary,
    ActiveWorkflowSummary,
    FailedWorkflowSummary,
    ExecutionStartedPayload,
    WorkflowCompletedPayload,
    WorkflowFailedPayload,
    UnityErrorPayload
} from '../types/coordinator';
import { DefaultSystemPrompts, SystemPromptConfig } from '../types';
import { getEffectiveCoordinatorPrompts } from './WorkflowSettingsManager';

/**
 * Coordinator Agent State - exposed for UI display
 */
export type CoordinatorState = 'idle' | 'queuing' | 'evaluating' | 'cooldown';

/**
 * Coordinator status information for UI
 */
export interface CoordinatorStatus {
    state: CoordinatorState;
    pendingEvents: number;
    lastEvaluation?: string;
    evaluationCount: number;
}

/**
 * AI Coordinator Agent - Makes intelligent decisions about workflow dispatch
 * 
 * This agent is event-driven and evaluates the current situation when triggered.
 * It has access to:
 * - The full plan (or summary)
 * - History of previous decisions and outcomes
 * - Current state (tasks, workflows, agents)
 * 
 * It outputs structured decisions that the coordinator service executes.
 * 
 * The base prompt (roleIntro and decisionInstructions) is configurable via settings.
 * Runtime context (events, plan, state) is built dynamically.
 */
/**
 * Debounce configuration for rate limiting evaluations
 */
interface DebounceConfig {
    debounceMs: number;     // Quiet time before running (default: 2000)
    maxWaitMs: number;      // Max wait before force run (default: 10000)
    cooldownMs: number;     // Cooldown after eval completes (default: 10000)
}

const DEFAULT_DEBOUNCE_CONFIG: DebounceConfig = {
    debounceMs: 2000,
    maxWaitMs: 10000,
    cooldownMs: 120000  // 2 minutes - coordinator evals take ~100s
};

export class CoordinatorAgent {
    private agentRunner: AgentRunner;
    private outputManager: OutputChannelManager;
    private broadcaster: EventBroadcaster;
    private config: CoordinatorAgentConfig;
    private roleRegistry?: AgentRoleRegistry;
    private workflowRegistry?: import('./workflows').WorkflowRegistry;
    private unityEnabled: boolean = true;
    private workspaceRoot: string = process.cwd();
    private evaluationCount: number = 0;
    
    // Debounce state
    private debounceConfig: DebounceConfig;
    private debounceTimer: NodeJS.Timeout | null = null;
    private firstEventAt: number = 0;
    private lastEvalCompletedAt: number = 0;
    private pendingEvents: Array<{ sessionId: string; event: CoordinatorEvent }> = [];
    
    // Callback for executing decisions
    private executeDecisionCallback?: (sessionId: string, decision: CoordinatorDecision) => Promise<void>;
    
    // State tracking for UI
    private currentState: CoordinatorState = 'idle';
    private lastEvaluationTime?: string;
    private readonly _onStateChanged = new TypedEventEmitter<CoordinatorStatus>();
    readonly onStateChanged = this._onStateChanged.event;

    constructor(config: Partial<CoordinatorAgentConfig> = {}, roleRegistry?: AgentRoleRegistry) {
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        this.broadcaster = ServiceLocator.resolve(EventBroadcaster);
        this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
        this.roleRegistry = roleRegistry;
        this.debounceConfig = DEFAULT_DEBOUNCE_CONFIG;
    }
    
    /**
     * Set the role registry (for dependency injection after construction)
     */
    setRoleRegistry(registry: AgentRoleRegistry): void {
        this.roleRegistry = registry;
    }
    
    /**
     * Set the workflow registry (for dynamic workflow prompts)
     */
    setWorkflowRegistry(registry: import('./workflows').WorkflowRegistry): void {
        this.workflowRegistry = registry;
    }
    
    /**
     * Set whether Unity features are enabled (affects which workflows are available)
     */
    setUnityEnabled(enabled: boolean): void {
        this.unityEnabled = enabled;
    }
    
    /**
     * Set the workspace root (for loading user settings)
     */
    setWorkspaceRoot(root: string): void {
        this.workspaceRoot = root;
    }
    
    // ========================================================================
    // State Tracking (for UI display)
    // ========================================================================
    
    /**
     * Get the current coordinator state
     */
    getState(): CoordinatorState {
        return this.currentState;
    }
    
    /**
     * Get full coordinator status for UI
     */
    getStatus(): CoordinatorStatus {
        return {
            state: this.currentState,
            pendingEvents: this.pendingEvents.length,
            lastEvaluation: this.lastEvaluationTime,
            evaluationCount: this.evaluationCount
        };
    }
    
    /**
     * Update coordinator state and fire event
     */
    private setState(newState: CoordinatorState): void {
        if (this.currentState !== newState) {
            this.currentState = newState;
            const status = this.getStatus();
            this._onStateChanged.fire(status);
            
            // Broadcast to all connected clients
            this.broadcaster.coordinatorStatusChanged(
                status.state,
                status.pendingEvents,
                status.evaluationCount,
                status.lastEvaluation
            );
        }
    }

    /**
     * Evaluate the current situation and make decisions
     * 
     * The AI executes commands directly via run_terminal_cmd.
     * If evaluation fails, throws an error for retry handling upstream.
     * 
     * @param input - Full context including event, plan, history, and state
     * @returns Structured decision (mostly for logging - AI executes directly)
     * @throws Error if AI evaluation fails (caller should retry)
     */
    async evaluate(input: CoordinatorInput): Promise<CoordinatorDecision> {
        this.evaluationCount++;
        const evalId = `coord_eval_${this.evaluationCount}_${Date.now()}`;
        
        this.log(`Starting evaluation #${this.evaluationCount} for event: ${input.event.type}`);
        
        // Check capacity and cleanup orphans if over 100%
        await this.checkCapacityAndCleanup(input);
        
        // Check if cursor CLI is available
        const isAvailable = await this.agentRunner.isAvailable();
        if (!isAvailable) {
            this.log(`[ERROR] Cursor CLI not available - coordinator cannot run`);
            throw new Error('Cursor CLI not available. Make sure cursor is installed and in PATH.');
        }
        
        // Build the prompt with full context
        const prompt = this.buildPrompt(input);
        
        if (this.config.debug) {
            this.log(`[DEBUG] Prompt length: ${prompt.length} chars`);
        }
        
        // Set up log file for streaming output capture
        // Use global coordinator logs folder since coordinator is global (not session-specific)
        const logDir = this.getGlobalCoordinatorLogsFolder();
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logDir, `${timestamp}_${evalId}_stream.log`);
        
        // Note: Prompt is written to log file by CursorAgentRunner.run()
        // This centralizes prompt logging for all agents
        
        // Run the AI agent - it will call run_terminal_cmd directly
        // Use simpleMode (no streaming JSON) for coordinator - cleaner output
        const result = await this.agentRunner.run({
            id: evalId,
            prompt,
            cwd: this.workspaceRoot,
            model: this.config.model,
            timeoutMs: this.config.evaluationTimeout,
            logFile,  // Capture output
            simpleMode: true,  // Don't use streaming JSON - just execute and return
            onProgress: (msg) => this.log(`[eval] ${msg}`)
        });
        
        // Clean up old streaming log files after saving (keep last N runs worth)
        this.cleanupOldLogs(logDir);
        
        this.log(`[DEBUG] Coordinator stream log: ${logFile}`);
        
        // Debug logging: show raw output info
        const outputLength = result.output?.length || 0;
        const outputPreview = result.output?.substring(0, 500) || '(empty)';
        this.log(`[DEBUG] AI response: success=${result.success}, exitCode=${result.exitCode}, outputLength=${outputLength}`);
        this.log(`[DEBUG] Output preview:\n${outputPreview}${outputLength > 500 ? '\n...(truncated)' : ''}`);
        
        if (!result.success) {
            const error = result.error || 'Unknown error';
            this.log(`Evaluation failed: ${error}`);
            this.log(`[DEBUG] Full error output: ${result.output?.substring(0, 1000) || '(none)'}`);
            throw new Error(`Coordinator AI evaluation failed: ${error}`);
        }
        
        // Parse reasoning/confidence from output (for logging only)
        // The AI already executed commands via run_terminal_cmd
        const decision = this.parseDecision(result.output, input);
        
        this.log(`Evaluation complete. Reasoning: ${decision.reasoning.substring(0, 100)}...`);
        
        // Log if no reasoning was extracted (helps debug AI output format issues)
        if (decision.reasoning === 'No reasoning provided') {
            this.log(`[WARN] No REASONING section found in AI output. Expected format: "REASONING: <text>"`);
        }
        
        return decision;
    }
    
    /**
     * Get the global coordinator logs folder path
     * Requires StateManager to be available - no silent fallbacks
     */
    private getGlobalCoordinatorLogsFolder(): string {
        try {
            const stateManager = ServiceLocator.resolve(StateManager);
            return stateManager.getGlobalCoordinatorLogsFolder();
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`ERROR: Failed to get coordinator logs folder from StateManager: ${errorMsg}`);
            throw new Error(
                `Cannot determine coordinator logs folder: StateManager unavailable. ` +
                `Please ensure the system is properly initialized. Error: ${errorMsg}`
            );
        }
    }
    
    /**
     * Check system capacity and cleanup orphan processes if over 100%
     * This prevents resource exhaustion from accumulated orphan processes
     */
    private async checkCapacityAndCleanup(input: CoordinatorInput): Promise<void> {
        try {
            // Count cursor-agent processes (cross-platform)
            const { countCursorAgentProcesses } = await import('../utils/orphanCleanup');
            const processCount = countCursorAgentProcesses();
            
            // Calculate capacity
            const availableAgentCount = input.availableAgents?.length ?? 0;
            const busyAgentCount = input.agentStatuses?.filter(a => a.status === 'busy').length ?? 0;
            const totalAgentCount = availableAgentCount + busyAgentCount;
            
            if (totalAgentCount === 0) {
                // No agents configured - skip capacity check
                return;
            }
            
            const capacityPercent = (processCount / totalAgentCount) * 100;
            
            this.log(`[CAPACITY CHECK] ${processCount} cursor-agent processes, ${totalAgentCount} agents in pool (${capacityPercent.toFixed(0)}% capacity)`);
            
            // If over 100% capacity, cleanup orphans immediately
            if (capacityPercent > 100) {
                this.log(`[CAPACITY CHECK] ⚠️ OVER CAPACITY (${capacityPercent.toFixed(0)}%) - killing orphan processes...`);
                
                const processManager = ServiceLocator.resolve(ProcessManager);
                const killedCount = await processManager.killOrphanCursorAgents();
                
                if (killedCount > 0) {
                    this.log(`[CAPACITY CHECK] ✅ Killed ${killedCount} orphan processes`);
                    
                    // Re-count after cleanup (cross-platform)
                    const afterCount = countCursorAgentProcesses();
                    const afterCapacity = (afterCount / totalAgentCount) * 100;
                    this.log(`[CAPACITY CHECK] After cleanup: ${afterCount} processes (${afterCapacity.toFixed(0)}% capacity)`);
                } else {
                    this.log(`[CAPACITY CHECK] No orphan processes found - capacity issue may be from legitimate active workflows`);
                }
            }
        } catch (err) {
            this.log(`[CAPACITY CHECK] Warning: Failed to check capacity: ${err}`);
            // Don't throw - capacity check is a safety feature, not critical
        }
    }
    
    /**
     * Maximum number of evaluation runs to keep streaming logs for.
     * Only stream logs (.log files) are kept now.
     */
    private static readonly MAX_LOG_RUNS = 3;
    
    /**
     * Clean up old coordinator log files, keeping only the most recent runs.
     * Files are sorted by name (which includes timestamp) to determine age.
     * Only keeps streaming logs (.log files).
     */
    private cleanupOldLogs(logDir: string): void {
        try {
            const files = fs.readdirSync(logDir)
                .filter(f => f.endsWith('.log'))  // Only streaming logs
                .sort()
                .reverse(); // Newest first (timestamp is in filename)
            
            // Keep only last N streaming logs
            const maxFiles = CoordinatorAgent.MAX_LOG_RUNS;
            
            if (files.length > maxFiles) {
                const filesToDelete = files.slice(maxFiles);
                for (const file of filesToDelete) {
                    try {
                        fs.unlinkSync(path.join(logDir, file));
                    } catch (err) {
                        // Ignore deletion errors for individual files
                    }
                }
                this.log(`[DEBUG] Cleaned up ${filesToDelete.length} old coordinator log files`);
            }
        } catch (err) {
            // Don't fail if cleanup fails - it's not critical
            this.log(`[WARN] Failed to cleanup old coordinator logs: ${err}`);
        }
    }

    /**
     * Build the full prompt with all context for the AI
     * 
     * Structure:
     * 1. roleIntro (configurable) - Base role description
     * 2. Runtime context (dynamic) - Events, Plans, History, State
     * 3. decisionInstructions (configurable) - Decision guidelines and output format
     */
    private buildPrompt(input: CoordinatorInput): string {
        const historySection = this.formatHistory(input.history, input.sessionId);
        const tasksSection = this.formatTasks(input.tasks);
        const workflowsSection = this.formatWorkflows(input.activeWorkflows);
        const failedWorkflowsSection = this.formatFailedWorkflows(input.recentlyFailedWorkflows || []);
        const agentsSection = this.formatAgents(input.agentStatuses, input.availableAgents);
        const eventSection = this.formatEventSection(input);
        const plansSection = this.formatApprovedPlans(input);
        const capacitiesSection = this.formatSessionCapacities(input.sessionCapacities || []);
        const globalConflictsSection = this.formatGlobalConflicts(input.globalConflicts || []);
        
        // Get customizable prompt parts from registry (or use defaults)
        const defaultConfig = DefaultSystemPrompts['coordinator'];
        const promptConfig = this.roleRegistry?.getSystemPrompt('coordinator') || new SystemPromptConfig(defaultConfig);
        
        // Get user-configured workflow prompts (overrides + defaults)
        const userOverrides = getEffectiveCoordinatorPrompts(this.workspaceRoot);
        
        // Get dynamic workflow prompts from registry, with user overrides applied
        const workflowPrompts = this.workflowRegistry?.getCoordinatorPrompts(this.unityEnabled, userOverrides) || '';
        
        // Calculate TOTAL agent count (available pool + busy agents)
        // This is used for the 80% capacity rule
        const availableAgentCount = input.availableAgents?.length ?? 0;
        const busyAgentCount = input.agentStatuses?.filter(a => a.status === 'busy').length ?? 0;
        const totalAgentCount = availableAgentCount + busyAgentCount;
        
        // Replace template variables in decision instructions
        const decisionInstructions = (promptConfig.decisionInstructions || '')
            .replace('{{sessionId}}', input.sessionId)
            .replace('{{timestamp}}', String(Date.now()))
            .replace('{{WORKFLOW_SELECTION}}', workflowPrompts || 'No workflows registered')
            .replace('{{planPath}}', input.planPath || 'N/A')
            .replace(/\{\{AVAILABLE_AGENT_COUNT\}\}/g, String(totalAgentCount))
            .replace('{{SESSION_CAPACITIES}}', capacitiesSection);
        
        return `${promptConfig.roleIntro}

═══════════════════════════════════════════════════════════════════════════════
TRIGGERING EVENT(S)
═══════════════════════════════════════════════════════════════════════════════

${eventSection}

═══════════════════════════════════════════════════════════════════════════════
APPROVED PLANS
═══════════════════════════════════════════════════════════════════════════════

${plansSection}

═══════════════════════════════════════════════════════════════════════════════
DECISION HISTORY
═══════════════════════════════════════════════════════════════════════════════

${historySection}

═══════════════════════════════════════════════════════════════════════════════
CURRENT STATE
═══════════════════════════════════════════════════════════════════════════════

--- TASKS (use \`apc task list\` for full details) ---
${tasksSection}

--- ACTIVE WORKFLOWS ---
${workflowsSection}

--- RECENTLY FAILED WORKFLOWS ---
${failedWorkflowsSection}

--- AGENTS ---
${agentsSection}

--- CROSS-PLAN FILE CONFLICTS ---
${globalConflictsSection}

═══════════════════════════════════════════════════════════════════════════════
YOUR DECISION
═══════════════════════════════════════════════════════════════════════════════

${decisionInstructions}`;
    }

    /**
     * Format history section for the prompt
     * 
     * Instead of embedding history (which contains stale state info that confuses the AI),
     * we just provide the file path. The AI can read it if needed.
     */
    private formatHistory(history: CoordinatorHistoryEntry[], sessionId?: string): string {
        if (history.length === 0) {
            return 'No previous decisions.';
        }
        
        // Get history file path
        let historyPath = 'History file path unavailable';
        try {
            const stateManager = ServiceLocator.resolve(StateManager);
            historyPath = stateManager.getCoordinatorHistoryPath(sessionId || '');
        } catch {
            // StateManager might not be available
        }
        
        return `${history.length} previous evaluations recorded.
History file: ${historyPath}
⚠️ Read ONLY if you need to understand past decisions. Do NOT use old state info from history for current decisions.`;
    }

    /**
     * Format tasks for the prompt
     */
    private formatTasks(tasks: TaskSummary[]): string {
        if (tasks.length === 0) return 'No tasks.';

        const byStatus: Record<string, TaskSummary[]> = {};
        for (const task of tasks) {
            if (!byStatus[task.status]) byStatus[task.status] = [];
            byStatus[task.status].push(task);
        }

        let result = '';
        
        // Show awaiting_decision tasks FIRST - these need immediate attention
        const awaitingDecision = byStatus['awaiting_decision'] || [];
        if (awaitingDecision.length > 0) {
            result += `⚡ AWAITING YOUR DECISION (${awaitingDecision.length}):\n`;
            result += awaitingDecision.map(t => 
                `  - ${t.id}: ${t.description} | Workflow finished - mark complete, fail, or start another workflow`
            ).join('\n');
            result += '\n\n';
        }
        
        // Show ready tasks (created with all deps complete) - these should have workflows started!
        const readyTasks = tasks.filter(t => 
            (t.status === 'created' || t.status === 'pending') && t.dependencyStatus === 'all_complete'
        );
        if (readyTasks.length > 0) {
            result += `🚀 READY TO DISPATCH - START WORKFLOWS NOW (${readyTasks.length}):\n`;
            result += `   ⚡ These tasks already exist. Use \`apc task start\` to begin workflows.\n`;
            result += readyTasks.map(t => {
                // Show context status only if task needs context
                let contextInfo = '';
                if (t.needsContext) {
                    const ctxStatus = t.contextWorkflowStatus || 'none';
                    contextInfo = ctxStatus === 'succeeded' ? ' | CTX ✓' : ` | CTX: ${ctxStatus} ⚠️`;
                }
                return `  - ${t.id}: ${t.description} | Type: ${t.type} | Priority: ${t.priority}${contextInfo}`;
            }).join('\n');
            result += '\n\n';
        }

        // Show in-progress tasks
        const inProgress = byStatus['in_progress'] || [];
        if (inProgress.length > 0) {
            result += `IN PROGRESS (${inProgress.length}):\n`;
            result += inProgress.map(t => 
                `  - ${t.id}: ${t.description} | Agent: ${t.assignedAgent || 'unassigned'}`
            ).join('\n');
            result += '\n\n';
        }

        // Show blocked tasks (waiting on dependencies) with context status
        const blocked = byStatus['blocked'] || [];
        if (blocked.length > 0) {
            result += `BLOCKED (${blocked.length}):\n`;
            result += blocked.map(t => {
                const deps = t.dependencies.join(', ') || 'none';
                // Show context status only if task needs context
                let contextInfo = '';
                if (t.needsContext) {
                    const ctxStatus = t.contextWorkflowStatus || 'none';
                    contextInfo = ` | CTX: ${ctxStatus}`;
                }
                return `  - ${t.id}: ${t.description} | Deps: ${deps}${contextInfo}`;
            }).join('\n');
            result += '\n\n';
        }

        // Summary of other states
        const succeeded = byStatus['succeeded'] || [];
        // NOTE: No 'failed' tasks - tasks stay in awaiting_decision until retried
        const pendingBlocked = tasks.filter(t => 
            (t.status === 'created' || t.status === 'pending') && t.dependencyStatus !== 'all_complete'
        );
        
        result += `Summary: ${succeeded.length} succeeded, ${pendingBlocked.length} waiting on deps`;

        return result;
    }

    /**
     * Format active workflows for the prompt
     */
    private formatWorkflows(workflows: ActiveWorkflowSummary[]): string {
        if (workflows.length === 0) return 'No active workflows.';

        return workflows.map(w => 
            `- ${w.id.substring(0, 8)}... | ${w.type} | ${w.status} | Phase: ${w.phase} (${w.phaseProgress}%) | Task: ${w.taskId || 'N/A'} | Agent: ${w.agentName || 'none'}`
        ).join('\n');
    }

    /**
     * Format recently failed workflows for the prompt
     * This helps the coordinator know about failures and react appropriately
     */
    private formatFailedWorkflows(workflows: FailedWorkflowSummary[]): string {
        if (workflows.length === 0) return 'No recent workflow failures.';

        return workflows.map(w => 
            `- ${w.id.substring(0, 8)}... | ${w.type} | Task: ${w.taskId || 'N/A'} | Phase: ${w.phase}\n  ERROR: ${w.error.substring(0, 200)}${w.error.length > 200 ? '...' : ''}`
        ).join('\n');
    }

    /**
     * Format agent status for the prompt
     */
    private formatAgents(statuses: CoordinatorInput['agentStatuses'], available: string[]): string {
        if (statuses.length === 0) return 'No agents configured.';

        const availableList = available.length > 0 
            ? `Available: ${available.join(', ')}`
            : 'No agents available';

        const busyAgents = statuses.filter(a => a.status === 'busy');
        const busyList = busyAgents.length > 0
            ? `\nBusy: ${busyAgents.map(a => `${a.name} (${a.currentTask || 'unknown task'})`).join(', ')}`
            : '';

        return `${availableList}${busyList}\n\nTotal: ${statuses.length} agents (${available.length} available, ${busyAgents.length} busy)`;
    }

    /**
     * Format approved plans for multi-plan coordinator view
     */
    private formatApprovedPlans(input: CoordinatorInput): string {
        const plans = input.approvedPlans || [];
        
        if (plans.length === 0) {
            throw new Error(
                'No approved plans provided to coordinator. ' +
                'Cannot proceed without plan data. ' +
                'This indicates a workflow configuration error.'
            );
        }
        
        return `${plans.length} approved plan(s):\n\n` + plans.map((p, i) => 
            `[${i + 1}] Session: ${p.sessionId}\n    Plan File: ${p.planPath}\n    Requirement: ${p.requirement}\n    Status: ${p.status}`
        ).join('\n\n');
    }
    
    /**
     * Format session capacity information for the prompt
     * Shows per-session agent limits and current allocation
     */
    private formatSessionCapacities(capacities: any[]): string {
        if (!capacities || capacities.length === 0) {
            return 'No session capacity data available.';
        }
        
        return capacities.map(c => {
            const status = c.availableCapacity > 0 
                ? `✅ Can add ${c.availableCapacity} more agent(s)`
                : '🔴 FULL - cannot add more agents';
            
            return `- ${c.sessionId}: Recommends ${c.recommendedAgents} agents, currently using ${c.currentlyAllocated} (${c.activeWorkflows} workflows)\n  ${status}`;
        }).join('\n');
    }
    
    /**
     * Format global file conflicts for cross-plan dependency awareness
     * Shows files touched by tasks from multiple sessions that need sequencing
     */
    private formatGlobalConflicts(conflicts: import('../types/coordinator').GlobalFileConflict[]): string {
        if (!conflicts || conflicts.length === 0) {
            return 'No cross-plan file conflicts detected.';
        }
        
        return `⚠️ ${conflicts.length} file(s) touched by multiple sessions - SEQUENCE CAREFULLY:\n\n` +
            conflicts.map(c => {
                const taskList = c.tasks.map(t => 
                    `    - ${t.taskId} (${t.sessionId}) [${t.status}]: ${t.description.substring(0, 50)}...`
                ).join('\n');
                return `📁 ${c.file}:\n${taskList}`;
            }).join('\n\n') +
            '\n\n💡 Use `apc task add-dep` to add cross-plan dependencies if needed.';
    }

    /**
     * Format the event section, handling batch events specially
     */
    private formatEventSection(input: CoordinatorInput): string {
        const payload = input.event.payload as any;
        
        // Check if this is a batch of events
        if (payload?.type === 'batch_events' && Array.isArray(payload.events)) {
            const events = payload.events;
            let result = `BATCH EVALUATION: ${events.length} events occurred during cooldown period\n\n`;
            
            result += events.map((e: any, i: number) => {
                return `[${i + 1}] ${e.type} at ${e.timestamp}\n    ${JSON.stringify(e.payload, null, 2).split('\n').join('\n    ')}`;
            }).join('\n\n');
            
            result += `\n\nPrimary Event Type: ${input.event.type}`;
            result += `\nConsider ALL events when making decisions.`;
            
            return result;
        }
        
        // Single event - format execution_started specially to highlight missing tasks
        if (input.event.type === 'execution_started') {
            const execPayload = input.event.payload as ExecutionStartedPayload;
            const missing = execPayload.totalTasksInPlan - execPayload.tasksCreated;
            
            let result = `Event Type: ${input.event.type}
Session ID: ${input.sessionId}
Timestamp: ${input.event.timestamp}

📋 TASK CREATION STATUS:
- Auto-created: ${execPayload.tasksCreated}/${execPayload.totalTasksInPlan} tasks
- Already exist: ${execPayload.taskCount} tasks in TaskManager`;
            
            if (missing > 0) {
                result += `
⚠️ MISSING TASKS: ${missing} tasks need to be created by coordinator`;
                if (execPayload.failedToCreate.length > 0) {
                    result += `
   Failed IDs: ${execPayload.failedToCreate.slice(0, 10).join(', ')}${execPayload.failedToCreate.length > 10 ? '...' : ''}`;
                }
                result += `

**ACTION REQUIRED**: Read the plan file and create the missing ${missing} tasks.
Create tasks in dependency order (5 at a time max), starting with tasks that have no dependencies.`;
            } else if (execPayload.tasksCreated === execPayload.totalTasksInPlan) {
                result += `
✅ All tasks auto-created successfully. Start workflows for ready tasks.`;
            }
            
            result += `

Plan File: ${execPayload.planPath}`;
            return result;
        }
        
        return `Event Type: ${input.event.type}
Session ID: ${input.sessionId}
Timestamp: ${input.event.timestamp}

Event Details:
${JSON.stringify(input.event.payload, null, 2)}`;
    }

    /**
     * Parse AI output into structured decision
     * 
     * New architecture: The AI executes commands directly via run_terminal_cmd.
     * We only extract reasoning/confidence for logging - no command parsing needed.
     */
    /**
     * Parse AI output for logging purposes only.
     * AI executes commands directly via run_terminal_cmd - no command parsing needed.
     */
    private parseDecision(output: string, _input: CoordinatorInput): CoordinatorDecision {
        // Extract reasoning and confidence for logging
        const reasoningMatch = output.match(/REASONING:\s*(.+?)(?=CONFIDENCE:|```|$)/s);
        const confidenceMatch = output.match(/CONFIDENCE:\s*([\d.]+)/);
        
        const reasoning = reasoningMatch 
            ? reasoningMatch[1].trim() 
            : 'No reasoning provided';
        const confidence = confidenceMatch 
            ? parseFloat(confidenceMatch[1]) 
            : 0.7;
        
        // AI executes commands directly via run_terminal_cmd
        // This decision object is only for logging/history
        return { reasoning, confidence };
    }

    /**
     * Log message to output channel
     */
    private log(message: string): void {
        this.outputManager.log('COORD-AI', message);
    }
    
    // ========================================================================
    // Event Queuing & Debounce
    // ========================================================================
    
    /**
     * Set callback for executing decisions
     * This allows the agent to remain decoupled from workflow dispatch
     */
    setExecuteDecisionCallback(callback: (sessionId: string, decision: CoordinatorDecision) => Promise<void>): void {
        this.executeDecisionCallback = callback;
    }
    
    /**
     * Queue an event for evaluation with debouncing
     * 
     * Uses debounce + max wait + cooldown:
     * - Debounce: Reset timer on each new event, run when quiet
     * - Max wait: Force execution if events keep coming
     * - Cooldown: After evaluation completes, block new evals (events queued)
     */
    queueEvent(
        sessionId: string,
        eventType: CoordinatorEventType,
        payload: any,
        buildInputFn: (sessionId: string, event: CoordinatorEvent) => Promise<CoordinatorInput>
    ): void {
        const event: CoordinatorEvent = {
            type: eventType,
            sessionId,
            timestamp: new Date().toISOString(),
            payload
        };
        
        this.pendingEvents.push({ sessionId, event });
        
        if (this.pendingEvents.length === 1) {
            this.firstEventAt = Date.now();
        }
        
        // Update state to queuing (unless already evaluating)
        if (this.currentState !== 'evaluating') {
            this.setState('queuing');
        }
        
        this.log(`Queued event ${eventType} for session ${sessionId} (${this.pendingEvents.length} pending)`);
        
        const now = Date.now();
        const timeSinceLastEval = now - this.lastEvalCompletedAt;
        const inCooldown = this.lastEvalCompletedAt > 0 && 
                          timeSinceLastEval < this.debounceConfig.cooldownMs;
        
        const waitedTime = now - this.firstEventAt;
        const maxWaitExceeded = waitedTime >= this.debounceConfig.maxWaitMs;
        
        if (maxWaitExceeded && !inCooldown) {
            this.log(`Max wait exceeded (${Math.round(waitedTime/1000)}s), forcing evaluation`);
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
                this.debounceTimer = null;
            }
            this.executePendingEvaluations(buildInputFn).catch(e => {
                this.log(`Forced evaluation failed: ${e}`);
            });
            return;
        }
        
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        let delay = this.debounceConfig.debounceMs;
        if (inCooldown) {
            const remainingCooldown = this.debounceConfig.cooldownMs - timeSinceLastEval;
            delay = remainingCooldown + this.debounceConfig.debounceMs;
            this.log(`In cooldown, scheduling for ${Math.round(delay/1000)}s`);
        }
        
        this.debounceTimer = setTimeout(() => {
            this.executePendingEvaluations(buildInputFn).catch(e => {
                this.log(`Debounced evaluation failed: ${e}`);
            });
        }, delay);
    }
    
    /**
     * Execute all pending evaluations
     * 
     * IMPORTANT: This method is guarded against concurrent execution.
     * If an evaluation is already in progress, we reschedule to try again later.
     */
    private async executePendingEvaluations(
        buildInputFn: (sessionId: string, event: CoordinatorEvent) => Promise<CoordinatorInput>
    ): Promise<void> {
        this.debounceTimer = null;
        
        if (this.pendingEvents.length === 0) {
            this.setState('idle');
            return;
        }
        
        // GUARD: Prevent concurrent evaluations
        // If already evaluating, reschedule to try again after a delay
        if (this.currentState === 'evaluating') {
            this.log(`⚠️ Evaluation already in progress - rescheduling ${this.pendingEvents.length} pending events`);
            
            // Reschedule after a short delay (5 seconds)
            // Events remain in pendingEvents, so they'll be picked up
            this.debounceTimer = setTimeout(() => {
                this.executePendingEvaluations(buildInputFn).catch(e => {
                    this.log(`Rescheduled evaluation failed: ${e}`);
                });
            }, 5000);
            return;
        }
        
        // Set state to evaluating
        this.setState('evaluating');
        
        const allEvents = [...this.pendingEvents];
        this.pendingEvents = [];
        this.firstEventAt = 0;
        
        this.log(`Debounce fired: Processing ${allEvents.length} events`);
        
        // Group events by session
        const eventsBySession = new Map<string, CoordinatorEvent[]>();
        for (const { sessionId, event } of allEvents) {
            if (!eventsBySession.has(sessionId)) {
                eventsBySession.set(sessionId, []);
            }
            eventsBySession.get(sessionId)!.push(event);
        }
        
        // Run evaluations sequentially with retry
        for (const [sessionId, events] of eventsBySession) {
            const combinedEvent = this.combineEvents(sessionId, events);
            this.log(`Running evaluation for session ${sessionId} with ${events.length} events`);
            
            // Retry logic: try up to 3 times with exponential backoff
            const maxRetries = 3;
            let lastError: Error | null = null;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const input = await buildInputFn(sessionId, combinedEvent);
                    const decision = await this.evaluate(input);
                    
                    if (this.executeDecisionCallback) {
                        await this.executeDecisionCallback(sessionId, decision);
                    }
                    
                    // Success - break retry loop
                    lastError = null;
                    break;
                    
                } catch (e) {
                    lastError = e instanceof Error ? e : new Error(String(e));
                    
                    if (attempt < maxRetries) {
                        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                        this.log(`Evaluation attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying in ${delayMs/1000}s...`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                }
            }
            
            if (lastError) {
                this.log(`Evaluation failed for session ${sessionId} after ${maxRetries} attempts: ${lastError.message}`);
            }
        }
        
        this.lastEvalCompletedAt = Date.now();
        this.lastEvaluationTime = new Date().toISOString();
        
        // Set state to cooldown, then schedule transition back to idle
        this.setState('cooldown');
        
        // After cooldown period, transition to idle (if no new events queued)
        setTimeout(() => {
            if (this.currentState === 'cooldown' && this.pendingEvents.length === 0) {
                this.setState('idle');
            }
        }, this.debounceConfig.cooldownMs);
    }
    
    /**
     * Combine multiple events into a single batch event
     */
    combineEvents(sessionId: string, events: CoordinatorEvent[]): CoordinatorEvent {
        const eventSummaries = events.map(e => ({
            type: e.type,
            timestamp: e.timestamp,
            payload: e.payload
        }));
        
        // Priority order for determining primary event type
        const priorityOrder: CoordinatorEventType[] = [
            'unity_error',
            'workflow_failed', 
            'workflow_completed',
            'user_responded',
            'agent_available',
            'manual_evaluation',
            'execution_started',
            'workflow_blocked'
        ];
        
        let primaryType: CoordinatorEventType = events[0].type;
        for (const type of priorityOrder) {
            if (events.some(e => e.type === type)) {
                primaryType = type;
                break;
            }
        }
        
        return {
            type: primaryType,
            sessionId,
            timestamp: new Date().toISOString(),
            payload: {
                type: 'batch_events',
                events: eventSummaries,
                summary: `Batch of ${events.length} events: ${[...new Set(events.map(e => e.type))].join(', ')}`
            } as any
        };
    }
    
    // ========================================================================
    // History Logging
    // ========================================================================
    
    /**
     * Create a history entry from an event and decision
     * NOTE: AI executes commands directly via run_terminal_cmd,
     * so dispatch counts are not tracked in decision anymore.
     */
    createHistoryEntry(event: CoordinatorEvent, decision: CoordinatorDecision): CoordinatorHistoryEntry {
        return {
            timestamp: new Date().toISOString(),
            event: {
                type: event.type,
                summary: this.summarizeEvent(event)
            },
            decision: {
                dispatchCount: 0,  // AI dispatches directly via CLI
                dispatchedTasks: [],
                cancelledCount: 0,
                reasoning: decision.reasoning
            }
        };
    }
    
    /**
     * Summarize an event for history
     */
    summarizeEvent(event: CoordinatorEvent): string {
        switch (event.type) {
            case 'execution_started':
                return `Started execution with ${(event.payload as ExecutionStartedPayload).taskCount} tasks`;
            case 'workflow_completed':
                return `Workflow ${(event.payload as WorkflowCompletedPayload).workflowType} completed`;
            case 'workflow_failed':
                return `Workflow failed: ${(event.payload as WorkflowFailedPayload).error?.substring(0, 50)}`;
            case 'unity_error':
                return `Unity errors: ${(event.payload as UnityErrorPayload).errors.length} errors`;
            case 'user_responded':
                return `User responded to question`;
            case 'agent_available':
                return `Agent available`;
            default:
                return event.type;
        }
    }
    
    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingEvents = [];
        this._onStateChanged.dispose();
    }
}

