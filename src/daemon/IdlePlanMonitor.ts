/**
 * IdlePlanMonitor - Monitors approved plans and triggers coordinator for optimal agent utilization
 * 
 * This service runs in the daemon and checks every 10 seconds for:
 * - Approved plans with NO active workflows → trigger after 60s idle
 * - Approved plans WITH active workflows but have ready tasks + available agents → trigger immediately
 * 
 * This enables:
 * - Periodic coordinator evaluations to maximize agent utilization
 * - Event-driven triggers (workflow completion, errors, etc.) still work
 * - 5-minute cooldown prevents excessive coordinator evaluations per plan
 * 
 * Protection layers:
 * - 5-minute cooldown (this monitor) prevents plan spam
 * - 10s debounce/cooldown (CoordinatorAgent) prevents evaluation spam
 * - Duplicate workflow check (UnifiedCoordinatorService) prevents duplicate starts
 * - 80% capacity rule (Coordinator AI) prevents resource exhaustion
 */

import { StateManager } from '../services/StateManager';
import { AgentPoolService } from '../services/AgentPoolService';
import { UnifiedCoordinatorService } from '../services/UnifiedCoordinatorService';
import { OutputChannelManager } from '../services/OutputChannelManager';

interface IdlePlanState {
    sessionId: string;
    idleSince: number;  // Timestamp when plan became idle
    lastTrigger: number;  // Timestamp of last coordinator trigger
}

export class IdlePlanMonitor {
    // Configuration
    private static readonly CHECK_INTERVAL_MS = 10000;  // Check every 10 seconds
    private static readonly IDLE_THRESHOLD_MS = 60000;  // Plan must be idle for 60 seconds
    private static readonly COOLDOWN_MS = 5 * 60 * 1000;  // 5 minutes cooldown after trigger
    
    private checkInterval: NodeJS.Timeout | null = null;
    private idlePlans: Map<string, IdlePlanState> = new Map();
    private outputManager?: OutputChannelManager;
    private hasTriggeredStartup: boolean = false;
    private systemReady: boolean = false;
    
    constructor(
        private stateManager: StateManager,
        private agentPoolService: AgentPoolService,
        private coordinator: UnifiedCoordinatorService
    ) {}
    
    /**
     * Set the output manager for logging
     */
    setOutputManager(outputManager: OutputChannelManager): void {
        this.outputManager = outputManager;
    }
    
    /**
     * Signal that the system is ready (dependencies checked, services initialized)
     * This enables startup evaluation to proceed
     */
    setSystemReady(): void {
        if (this.systemReady) {
            return;  // Already set
        }
        
        this.systemReady = true;
        this.log('System marked as ready');
        
        // If monitor is already running but startup eval was skipped, trigger it now
        if (this.checkInterval && !this.hasTriggeredStartup) {
            this.log('System ready - triggering deferred startup evaluation');
            this.triggerStartupEvaluation();
        }
    }
    
    /**
     * Start monitoring for idle plans
     * @param triggerImmediately If true, trigger coordinator for existing approved plans immediately on startup (if system is ready)
     */
    start(triggerImmediately: boolean = true): void {
        if (this.checkInterval) {
            return;  // Already running
        }
        
        this.log('Starting idle plan monitor');
        
        // On startup, trigger immediately for any existing approved plans
        // BUT only if system is ready (dependencies checked, services initialized)
        if (triggerImmediately && !this.hasTriggeredStartup) {
            if (this.systemReady) {
                this.triggerStartupEvaluation();
            } else {
                this.log('Startup evaluation deferred - waiting for system ready signal');
            }
        }
        
        this.checkInterval = setInterval(() => {
            this.checkIdlePlans();
        }, IdlePlanMonitor.CHECK_INTERVAL_MS);
        
        // Start normal tracking (won't trigger due to cooldown from startup)
        this.checkIdlePlans();
    }
    
    /**
     * Trigger coordinator for all existing approved plans on startup
     * This skips the idle threshold - we assume existing approved plans should be evaluated
     */
    private triggerStartupEvaluation(): void {
        const sessions = this.stateManager.getAllPlanningSessions()
            .filter(s => s.status === 'approved');
        
        const availableAgents = this.agentPoolService.getAvailableAgents();
        
        if (sessions.length === 0) {
            this.log('No approved plans found on startup');
            return;
        }
        
        if (availableAgents.length === 0) {
            this.log(`Found ${sessions.length} approved plan(s) but no agents available`);
            return;
        }
        
        this.log(`Startup: Found ${sessions.length} approved plan(s), ${availableAgents.length} agents available - triggering evaluation`);
        
        const now = Date.now();
        for (const session of sessions) {
            // Check if this session has active workflows
            const sessionState = this.coordinator.getSessionState(session.id);
            const hasActiveWorkflows = sessionState?.activeWorkflows && sessionState.activeWorkflows.size > 0;
            
            if (hasActiveWorkflows) {
                this.log(`Startup: Skipping ${session.id} - has active workflows`);
                continue;
            }
            
            // Trigger coordinator
            this.log(`Startup: Triggering coordinator for ${session.id}`);
            this.coordinator.triggerCoordinatorEvaluation(
                session.id,
                'manual_evaluation',
                {
                    type: 'manual_evaluation',
                    reason: `Daemon startup - evaluating approved plan with ${availableAgents.length} available agents`
                }
            ).catch(err => {
                this.log(`Startup: Failed to trigger coordinator for ${session.id}: ${err}`);
            });
            
            // Track this plan with last trigger set to now
            this.idlePlans.set(session.id, {
                sessionId: session.id,
                idleSince: now,
                lastTrigger: now  // Set to now so cooldown applies
            });
        }
        
        this.hasTriggeredStartup = true;
    }
    
    /**
     * Stop monitoring
     */
    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            this.log('Stopped idle plan monitor');
        }
    }
    
    /**
     * Check for plans that could use coordination and trigger when appropriate
     * 
     * New behavior (Option 1):
     * - Plans with NO active workflows: trigger after 60s idle (original behavior)
     * - Plans WITH active workflows BUT have ready tasks + available agents: trigger immediately
     * - This allows periodic coordinator evaluations to maximize agent utilization
     */
    private checkIdlePlans(): void {
        try {
            const now = Date.now();
            
            // Get all approved sessions
            const sessions = this.stateManager.getAllPlanningSessions()
                .filter(s => s.status === 'approved');
            
            // Get available agents
            const availableAgents = this.agentPoolService.getAvailableAgents();
            
            // If no available agents, nothing to do
            if (availableAgents.length === 0) {
                return;
            }
            
            // Get task manager for checking ready tasks
            const { ServiceLocator } = require('../services/ServiceLocator');
            const TaskManager = require('../services/TaskManager').TaskManager;
            let taskManager: any;
            try {
                taskManager = ServiceLocator.resolve(TaskManager);
            } catch {
                // Task manager not available - use conservative behavior (skip plans with workflows)
                this.log('TaskManager not available, using conservative mode');
            }
            
            for (const session of sessions) {
                // Check if this session has active workflows
                const sessionState = this.coordinator.getSessionState(session.id);
                const activeWorkflowCount = sessionState?.activeWorkflows?.size || 0;
                const hasActiveWorkflows = activeWorkflowCount > 0;
                
                // Check if there are ready tasks (tasks with all dependencies met)
                let readyTasks: any[] = [];
                let hasReadyTasks = false;
                
                if (taskManager) {
                    try {
                        readyTasks = taskManager.getReadyTasksForSession(session.id) || [];
                        hasReadyTasks = readyTasks.length > 0;
                    } catch (err) {
                        this.log(`Error checking ready tasks for ${session.id}: ${err}`);
                    }
                }
                
                // Determine if we should track this plan for coordination
                // Track if: (1) No workflows (idle), OR (2) Has ready tasks that could use available agents
                const shouldTrack = !hasActiveWorkflows || hasReadyTasks;
                
                if (!shouldTrack) {
                    // Has workflows but no ready tasks - nothing for coordinator to do
                    this.idlePlans.delete(session.id);
                    continue;
                }
                
                // Determine appropriate threshold based on situation
                // - Fully idle (no workflows): 60s threshold (less urgent, avoid spam)
                // - Has workflows + ready tasks: 0s threshold (immediate - maximize parallelization)
                const threshold = hasActiveWorkflows ? 0 : IdlePlanMonitor.IDLE_THRESHOLD_MS;
                
                // Get or create tracking state for this plan
                let planState = this.idlePlans.get(session.id);
                
                if (!planState) {
                    // Start tracking this plan
                    planState = {
                        sessionId: session.id,
                        idleSince: now,
                        lastTrigger: 0
                    };
                    this.idlePlans.set(session.id, planState);
                    
                    const reason = hasActiveWorkflows 
                        ? `has ${activeWorkflowCount} workflows + ${readyTasks.length} ready tasks`
                        : 'idle (no workflows)';
                    this.log(`Tracking plan: ${session.id} (${reason})`);
                    continue;  // Don't trigger on first detection
                }
                
                // Check if plan has been in this state long enough
                const timeSinceTracking = now - planState.idleSince;
                if (timeSinceTracking < threshold) {
                    continue;  // Not ready yet
                }
                
                // Check cooldown - respect minimum time between triggers
                const timeSinceLastTrigger = now - planState.lastTrigger;
                if (planState.lastTrigger > 0 && timeSinceLastTrigger < IdlePlanMonitor.COOLDOWN_MS) {
                    const remaining = Math.round((IdlePlanMonitor.COOLDOWN_MS - timeSinceLastTrigger) / 1000);
                    // Only log occasionally to avoid spam
                    if (remaining % 60 === 0) {
                        this.log(`Plan ${session.id} in cooldown (${remaining}s remaining)`);
                    }
                    continue;  // Still in cooldown
                }
                
                // Trigger coordinator evaluation
                const reason = hasActiveWorkflows
                    ? `${readyTasks.length} ready tasks with ${availableAgents.length} available agents (${activeWorkflowCount} workflows running)`
                    : `idle for ${Math.round(timeSinceTracking / 1000)}s with ${availableAgents.length} available agents`;
                
                this.log(`Triggering coordinator for ${session.id}: ${reason}`);
                
                this.coordinator.triggerCoordinatorEvaluation(
                    session.id,
                    'manual_evaluation',
                    {
                        type: 'manual_evaluation',
                        reason: `Periodic check - ${reason}`
                    }
                ).catch(err => {
                    this.log(`Failed to trigger coordinator for ${session.id}: ${err}`);
                });
                
                // Update last trigger time
                planState.lastTrigger = now;
            }
            
            // Clean up tracking for sessions that no longer exist or aren't approved
            const validSessionIds = new Set(sessions.map(s => s.id));
            for (const sessionId of this.idlePlans.keys()) {
                if (!validSessionIds.has(sessionId)) {
                    this.idlePlans.delete(sessionId);
                }
            }
        } catch (err) {
            this.log(`Error checking idle plans: ${err}`);
        }
    }
    
    /**
     * Get status of the monitor
     */
    getStatus(): {
        running: boolean;
        trackedPlans: number;
        planStates: Array<{ sessionId: string; idleSeconds: number; cooldownSeconds: number }>;
    } {
        const now = Date.now();
        return {
            running: this.checkInterval !== null,
            trackedPlans: this.idlePlans.size,
            planStates: Array.from(this.idlePlans.values()).map(p => ({
                sessionId: p.sessionId,
                idleSeconds: Math.round((now - p.idleSince) / 1000),
                cooldownSeconds: p.lastTrigger > 0 
                    ? Math.max(0, Math.round((IdlePlanMonitor.COOLDOWN_MS - (now - p.lastTrigger)) / 1000))
                    : 0
            }))
        };
    }
    
    private log(message: string): void {
        const msg = `[IdlePlanMonitor] ${message}`;
        if (this.outputManager) {
            this.outputManager.log('DAEMON', msg);
        } else {
            console.log(msg);
        }
    }
}

