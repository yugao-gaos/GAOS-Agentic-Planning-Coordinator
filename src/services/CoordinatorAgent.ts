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
import { AgentRunner } from './AgentBackend';
import { OutputChannelManager } from './OutputChannelManager';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { ServiceLocator } from './ServiceLocator';
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
    ExecutionStartedPayload,
    WorkflowCompletedPayload,
    WorkflowFailedPayload,
    UnityErrorPayload
} from '../types/coordinator';
import { DefaultCoordinatorPrompt } from '../types';
import { getEffectiveCoordinatorPrompts } from './WorkflowSettingsManager';

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
    cooldownMs: 10000
};

export class CoordinatorAgent {
    private agentRunner: AgentRunner;
    private outputManager: OutputChannelManager;
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

    constructor(config: Partial<CoordinatorAgentConfig> = {}, roleRegistry?: AgentRoleRegistry) {
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
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
        
        // Build the prompt with full context
        const prompt = this.buildPrompt(input);
        
        if (this.config.debug) {
            this.log(`[DEBUG] Prompt length: ${prompt.length} chars`);
        }
        
        // Save prompt to log file for debugging
        this.saveCoordinatorLog(input.sessionId, evalId, 'prompt', prompt);
        
        // Run the AI agent - it will call run_terminal_cmd directly
        const result = await this.agentRunner.run({
            id: evalId,
            prompt,
            cwd: process.cwd(),
            model: this.config.model,
            timeoutMs: this.config.evaluationTimeout,
            onProgress: (msg) => this.log(`[eval] ${msg}`)
        });
        
        // Save output to log file for debugging
        this.saveCoordinatorLog(input.sessionId, evalId, 'output', result.output || '(no output)');
        
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
     * Save coordinator prompt/output to log file for debugging
     */
    private saveCoordinatorLog(sessionId: string, evalId: string, type: 'prompt' | 'output', content: string): void {
        try {
            const logDir = `${this.workspaceRoot}/_AiDevLog/Plans/${sessionId}/coordinators`;
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${timestamp}_${evalId}_${type}.txt`;
            const filepath = `${logDir}/${filename}`;
            
            fs.writeFileSync(filepath, content);
            this.log(`[DEBUG] Saved coordinator ${type} to: ${filepath}`);
        } catch (err) {
            this.log(`[WARN] Failed to save coordinator log: ${err}`);
        }
    }

    /**
     * Build the full prompt with all context for the AI
     * 
     * Structure:
     * 1. roleIntro (configurable) - Base role description
     * 2. Runtime context (dynamic) - Events, Plan, History, State
     * 3. decisionInstructions (configurable) - Decision guidelines and output format
     */
    private buildPrompt(input: CoordinatorInput): string {
        const planContent = this.getPlanContent(input);
        const historySection = this.formatHistory(input.history);
        const tasksSection = this.formatTasks(input.tasks);
        const workflowsSection = this.formatWorkflows(input.activeWorkflows);
        const agentsSection = this.formatAgents(input.agentStatuses, input.availableAgents);
        const eventSection = this.formatEventSection(input);
        
        // Get customizable prompt parts from registry (or use defaults)
        const promptConfig = this.roleRegistry?.getCoordinatorPrompt() || DefaultCoordinatorPrompt;
        
        // Get user-configured workflow prompts (overrides + defaults)
        const userOverrides = getEffectiveCoordinatorPrompts(this.workspaceRoot);
        
        // Get dynamic workflow prompts from registry, with user overrides applied
        const workflowPrompts = this.workflowRegistry?.getCoordinatorPrompts(this.unityEnabled, userOverrides) || '';
        
        // Replace template variables in decision instructions
        const decisionInstructions = promptConfig.decisionInstructions
            .replace('{{sessionId}}', input.sessionId)
            .replace('{{timestamp}}', String(Date.now()))
            .replace('{{WORKFLOW_SELECTION}}', workflowPrompts || 'No workflows registered');
        
        return `${promptConfig.roleIntro}

═══════════════════════════════════════════════════════════════════════════════
TRIGGERING EVENT(S)
═══════════════════════════════════════════════════════════════════════════════

${eventSection}

═══════════════════════════════════════════════════════════════════════════════
THE PLAN
═══════════════════════════════════════════════════════════════════════════════

Requirement: ${input.planRequirement}

${planContent}

═══════════════════════════════════════════════════════════════════════════════
DECISION HISTORY (${input.history.length} previous evaluations)
═══════════════════════════════════════════════════════════════════════════════

${historySection || 'No previous decisions in this session.'}

═══════════════════════════════════════════════════════════════════════════════
CURRENT STATE
═══════════════════════════════════════════════════════════════════════════════

Session Status: ${input.sessionStatus}

--- TASKS ---
${tasksSection}

--- ACTIVE WORKFLOWS ---
${workflowsSection}

--- AGENTS ---
${agentsSection}

--- PENDING QUESTIONS ---
${input.pendingQuestions.length > 0 
    ? input.pendingQuestions.map(q => `[${q.id}] ${q.question} (asked ${q.askedAt})`).join('\n')
    : 'No pending questions.'}

═══════════════════════════════════════════════════════════════════════════════
YOUR DECISION
═══════════════════════════════════════════════════════════════════════════════

${decisionInstructions}`;
    }

    /**
     * Get plan content, potentially truncated
     */
    private getPlanContent(input: CoordinatorInput): string {
        if (!this.config.includePlanContent || !input.planPath) {
            return `Plan path: ${input.planPath || 'N/A'}`;
        }

        let content = input.planContent;
        
        if (content.length > this.config.maxPlanContentLength) {
            // Truncate but keep structure - show start and task breakdown
            const taskBreakdownIndex = content.indexOf('## Task Breakdown');
            if (taskBreakdownIndex > 0) {
                const start = content.substring(0, 2000);
                const taskSection = content.substring(taskBreakdownIndex, taskBreakdownIndex + this.config.maxPlanContentLength - 2500);
                content = `${start}\n\n... [content truncated] ...\n\n${taskSection}\n\n... [remaining content truncated] ...`;
            } else {
                content = content.substring(0, this.config.maxPlanContentLength) + '\n\n... [truncated] ...';
            }
        }

        return `Plan File: ${input.planPath}\n\n${content}`;
    }

    /**
     * Format history entries for the prompt
     */
    private formatHistory(history: CoordinatorHistoryEntry[]): string {
        if (history.length === 0) return '';

        return history.slice(-this.config.maxHistoryEntries).map((entry, i) => {
            const outcomeStr = entry.outcome 
                ? `\n   Outcome: ${entry.outcome.success ? '✓' : '✗'} ${entry.outcome.notes || ''}`
                : '';
            
            return `[${i + 1}] ${entry.timestamp}
   Event: ${entry.event.type} - ${entry.event.summary}
   Decision: Dispatched ${entry.decision.dispatchCount} tasks (${entry.decision.dispatchedTasks.join(', ') || 'none'})
            ${entry.decision.askedUser ? '| Asked user' : ''}
            ${entry.decision.pausedCount > 0 ? `| Paused ${entry.decision.pausedCount}` : ''}
   Reasoning: ${entry.decision.reasoning}${outcomeStr}`;
        }).join('\n\n');
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
        
        // Show ready tasks first (pending with all deps complete)
        const readyTasks = tasks.filter(t => 
            t.status === 'pending' && t.dependencyStatus === 'all_complete'
        );
        if (readyTasks.length > 0) {
            result += `READY TO DISPATCH (${readyTasks.length}):\n`;
            result += readyTasks.map(t => 
                `  - ${t.id}: ${t.description} | Type: ${t.type} | Priority: ${t.priority}`
            ).join('\n');
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

        // Show blocked/paused tasks
        const blocked = [...(byStatus['blocked'] || []), ...(byStatus['paused'] || [])];
        if (blocked.length > 0) {
            result += `BLOCKED/PAUSED (${blocked.length}):\n`;
            result += blocked.map(t => 
                `  - ${t.id}: ${t.description} | Status: ${t.status} | Deps: ${t.dependencies.join(', ') || 'none'}`
            ).join('\n');
            result += '\n\n';
        }

        // Summary of other states
        const completed = byStatus['completed'] || [];
        const failed = byStatus['failed'] || [];
        const pendingBlocked = tasks.filter(t => 
            t.status === 'pending' && t.dependencyStatus !== 'all_complete'
        );
        
        result += `Summary: ${completed.length} completed, ${failed.length} failed, ${pendingBlocked.length} waiting on deps`;

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
        
        // Single event
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
     */
    private async executePendingEvaluations(
        buildInputFn: (sessionId: string, event: CoordinatorEvent) => Promise<CoordinatorInput>
    ): Promise<void> {
        this.debounceTimer = null;
        
        if (this.pendingEvents.length === 0) {
            return;
        }
        
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
            'task_paused',
            'task_resumed',
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
     * so dispatch/pause/resume counts are not tracked in decision anymore.
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
                askedUser: false,
                pausedCount: 0,
                resumedCount: 0,
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
    }
}

