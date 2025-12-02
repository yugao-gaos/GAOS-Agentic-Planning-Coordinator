/**
 * IdlePlanMonitor - Monitors for idle approved plans and triggers coordinator
 * 
 * This service runs in the daemon and checks for:
 * - Approved plans with no active workflows
 * - Available agents in the pool
 * - Plans that have been idle for more than IDLE_THRESHOLD_MS
 * 
 * When conditions are met, it triggers a coordinator evaluation.
 * After triggering, it enters a cooldown period before checking again.
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
     * Start monitoring for idle plans
     * @param triggerImmediately If true, trigger coordinator for existing approved plans immediately on startup
     */
    start(triggerImmediately: boolean = true): void {
        if (this.checkInterval) {
            return;  // Already running
        }
        
        this.log('Starting idle plan monitor');
        
        // On startup, trigger immediately for any existing approved plans
        if (triggerImmediately && !this.hasTriggeredStartup) {
            this.triggerStartupEvaluation();
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
     * Check for idle approved plans and trigger coordinator if needed
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
            
            for (const session of sessions) {
                // Check if this session has active workflows
                const sessionState = this.coordinator.getSessionState(session.id);
                const hasActiveWorkflows = sessionState?.activeWorkflows && sessionState.activeWorkflows.size > 0;
                
                if (hasActiveWorkflows) {
                    // Not idle - remove from tracking
                    this.idlePlans.delete(session.id);
                    continue;
                }
                
                // Session is idle (approved, no workflows)
                let planState = this.idlePlans.get(session.id);
                
                if (!planState) {
                    // Start tracking this idle plan
                    planState = {
                        sessionId: session.id,
                        idleSince: now,
                        lastTrigger: 0
                    };
                    this.idlePlans.set(session.id, planState);
                    this.log(`Tracking idle plan: ${session.id}`);
                    continue;  // Don't trigger on first detection
                }
                
                // Check if plan has been idle long enough
                const idleDuration = now - planState.idleSince;
                if (idleDuration < IdlePlanMonitor.IDLE_THRESHOLD_MS) {
                    continue;  // Not idle long enough
                }
                
                // Check cooldown
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
                this.log(`Triggering coordinator for idle plan ${session.id} (idle ${Math.round(idleDuration / 1000)}s, ${availableAgents.length} agents available)`);
                
                this.coordinator.triggerCoordinatorEvaluation(
                    session.id,
                    'manual_evaluation',
                    {
                        type: 'manual_evaluation',
                        reason: `Idle plan detected - idle for ${Math.round(idleDuration / 1000)}s with ${availableAgents.length} available agents`
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

