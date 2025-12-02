#!/usr/bin/env node
/**
 * Standalone Daemon Entry Point
 * 
 * This module allows running the APC daemon without VS Code.
 * It initializes all services with headless implementations.
 * 
 * Usage:
 *   node standalone.js [workspaceRoot]
 *   APC_WORKSPACE_ROOT=/path/to/project node standalone.js
 * 
 * Environment Variables:
 *   APC_WORKSPACE_ROOT - Workspace root path
 *   APC_PORT - Port to listen on (default: 19840)
 *   APC_POOL_SIZE - Agent pool size (default: 10)
 *   APC_VERBOSE - Enable verbose logging (true/false)
 */

import { ApcDaemon, DaemonOptions } from './ApcDaemon';
import { ApiServices } from './ApiHandler';
import { findWorkspaceRoot, ConfigLoader, CoreConfig } from './DaemonConfig';
import { StateManager, StateManagerConfig } from '../services/StateManager';
import { AgentRoleRegistry } from '../services/AgentRoleRegistry';
import { AgentRole } from '../types';
import { AgentPoolService } from '../services/AgentPoolService';
import { UnifiedCoordinatorService } from '../services/UnifiedCoordinatorService';
import { PlanningService } from '../services/PlanningService';
import { HeadlessTerminalManager } from '../services/HeadlessTerminalManager';
import { AgentRunner } from '../services/AgentBackend';
import { OutputChannelManager } from '../services/OutputChannelManager';
import { TaskManager } from '../services/TaskManager';
import { UnityControlManager } from '../services/UnityControlManager';
import { bootstrapServices, ServiceLocator } from '../services/Bootstrap';
import { EventBroadcaster } from './EventBroadcaster';

/**
 * Initialize all services for standalone daemon mode
 */
async function initializeServices(config: CoreConfig): Promise<ApiServices> {
    console.log('[Standalone] Initializing services...');
    console.log(`[Standalone] Workspace: ${config.workspaceRoot}`);
    console.log(`[Standalone] Working directory: ${config.workingDirectory}`);
    console.log(`[Standalone] Agent pool size: ${config.agentPoolSize}`);
    
    // Bootstrap all services with ServiceLocator
    bootstrapServices();
    
    // Initialize output channel manager (file-only mode for standalone)
    const outputManager = ServiceLocator.resolve(OutputChannelManager);
    outputManager.setOutputTarget('file');
    
    // Initialize StateManager
    const stateManagerConfig: StateManagerConfig = {
        workspaceRoot: config.workspaceRoot,
        workingDirectory: config.workingDirectory,
        agentPoolSize: config.agentPoolSize,
        defaultBackend: config.defaultBackend
    };
    
    const stateManager = new StateManager(stateManagerConfig);
    await stateManager.initialize();
    console.log(`[Standalone] StateManager initialized with ${stateManager.getAllPlanningSessions().length} sessions`);
    
    // Initialize AgentRoleRegistry
    const roleRegistry = new AgentRoleRegistry(stateManager);
    // Unity features enabled by default (can be disabled via config or APC_ENABLE_UNITY=false)
    const enableUnity = config.enableUnityFeatures;
    roleRegistry.setUnityEnabled(enableUnity);
    console.log(`[Standalone] AgentRoleRegistry initialized, Unity: ${enableUnity ? 'enabled' : 'disabled'}`);
    
    // Initialize AgentPoolService
    const agentPoolService = new AgentPoolService(stateManager, roleRegistry);
    console.log(`[Standalone] AgentPoolService initialized with ${agentPoolService.getPoolStatus().total} agents`);
    
    // Initialize HeadlessTerminalManager (no-op for standalone)
    const terminalManager = new HeadlessTerminalManager();
    
    // Initialize AgentRunner with default backend
    const agentRunner = ServiceLocator.resolve(AgentRunner);
    agentRunner.setBackend(config.defaultBackend);
    console.log(`[Standalone] AgentRunner initialized with backend: ${config.defaultBackend}`);
    
    // Initialize UnityControlManager if Unity is enabled
    let unityManager: UnityControlManager | undefined;
    if (enableUnity) {
        unityManager = ServiceLocator.resolve(UnityControlManager);
        unityManager.setAgentRoleRegistry(roleRegistry);
        await unityManager.initialize(config.workspaceRoot);
        console.log('[Standalone] UnityControlManager initialized');
    }
    
    // Register and initialize UnifiedCoordinatorService
    ServiceLocator.register(UnifiedCoordinatorService, () => 
        new UnifiedCoordinatorService(stateManager, agentPoolService, roleRegistry)
    );
    const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
    
    // Connect coordinator to Unity manager if available
    if (enableUnity && unityManager) {
        coordinator.setUnityEnabled(true, unityManager);
    } else {
        coordinator.setUnityEnabled(false);
    }
    
    // Subscribe to agent allocation events and broadcast to clients
    const broadcaster = ServiceLocator.resolve(EventBroadcaster);
    coordinator.onAgentAllocated(({ agentName, sessionId, roleId, workflowId }) => {
        console.log(`[Standalone] onAgentAllocated: agent=${agentName}, session=${sessionId}, role=${roleId}, workflow=${workflowId}`);
        
        try {
            // Get log file path - include workflow ID and agent name for unique temp files
            // Guard against empty sessionId
            const logDir = sessionId ? stateManager.getPlanFolder(sessionId) : undefined;
            const logFile = logDir ? `${logDir}/logs/agents/${workflowId}_${agentName}.log` : undefined;
            
            broadcaster.broadcast('agent.allocated', {
                agentName,
                sessionId,
                roleId,
                workflowId,
                logFile
            });
            
            // Also broadcast pool change so UI shows agent as busy
            const poolStatus = agentPoolService.getPoolStatus();
            const busyAgents = agentPoolService.getBusyAgents();
            console.log(`[Standalone] Broadcasting pool.changed after allocation: available=${poolStatus.available.length}, busy=${busyAgents.length}`);
            broadcaster.poolChanged(
                poolStatus.total,
                poolStatus.available,
                busyAgents.map(b => ({ name: b.name, coordinatorId: b.coordinatorId || '', roleId: b.roleId }))
            );
        } catch (e) {
            console.error(`[Standalone] Error in onAgentAllocated handler:`, e);
            
            // Still try to broadcast pool.changed even if other parts failed
            try {
                const poolStatus = agentPoolService.getPoolStatus();
                const busyAgents = agentPoolService.getBusyAgents();
                broadcaster.poolChanged(
                    poolStatus.total,
                    poolStatus.available,
                    busyAgents.map(b => ({ name: b.name, coordinatorId: b.coordinatorId || '', roleId: b.roleId }))
                );
            } catch (e2) {
                console.error(`[Standalone] Failed to broadcast pool.changed:`, e2);
            }
        }
    });
    
    // Subscribe to session state changes and broadcast to clients
    // This ensures UI updates when workflows start/complete/change state
    coordinator.onSessionStateChanged((sessionId) => {
        const session = stateManager.getPlanningSession(sessionId);
        if (session) {
            broadcaster.broadcast('session.updated', {
                sessionId,
                status: session.status,
                previousStatus: session.status,
                changes: ['workflow_state_changed'],
                updatedAt: new Date().toISOString()
            });
        }
        
        // Also broadcast pool state since agent allocations may have changed
        const poolStatus2 = agentPoolService.getPoolStatus();
        const busyAgents2 = agentPoolService.getBusyAgents();
        broadcaster.poolChanged(
            poolStatus2.total,
            poolStatus2.available,
            busyAgents2.map(b => ({ name: b.name, coordinatorId: b.coordinatorId || '', roleId: b.roleId }))
        );
    });
    
    console.log('[Standalone] UnifiedCoordinatorService initialized');
    
    // Recover any paused sessions
    const recoveredCount = await coordinator.recoverAllSessions();
    if (recoveredCount > 0) {
        console.log(`[Standalone] Recovered ${recoveredCount} paused workflow(s)`);
    }
    
    // Initialize PlanningService
    const planningService = new PlanningService(stateManager, coordinator, {
        unityBestPracticesPath: config.unityBestPracticesPath
    });
    console.log('[Standalone] PlanningService initialized');
    
    // Return API services interface
    return {
        stateManager: {
            getAllPlanningSessions: () => stateManager.getAllPlanningSessions(),
            getPlanningSession: (id: string) => stateManager.getPlanningSession(id),
            deletePlanningSession: (id: string) => stateManager.deletePlanningSession(id)
        },
        agentPoolService: {
            getPoolStatus: () => agentPoolService.getPoolStatus(),
            getAvailableAgents: () => agentPoolService.getAvailableAgents(),
            getBusyAgents: () => agentPoolService.getBusyAgents(),
            getAllRoles: () => agentPoolService.getAllRoles(),
            getRole: (roleId: string) => agentPoolService.getRole(roleId),
            resizePool: (size: number) => agentPoolService.resizePool(size),
            releaseAgents: (names: string[]) => agentPoolService.releaseAgents(names)
        },
        coordinator: {
            getSessionState: (sessionId: string) => coordinator.getSessionState(sessionId),
            getWorkflowSummaries: (sessionId: string) => coordinator.getWorkflowSummaries(sessionId),
            getWorkflowStatus: (sessionId: string, workflowId: string) => coordinator.getWorkflowStatus(sessionId, workflowId),
            dispatchWorkflow: (sessionId: string, type: string, input: any) => coordinator.dispatchWorkflow(sessionId, type as any, input),
            cancelWorkflow: (sessionId: string, workflowId: string) => coordinator.cancelWorkflow(sessionId, workflowId),
            pauseSession: (sessionId: string) => coordinator.pauseSession(sessionId),
            resumeSession: (sessionId: string) => coordinator.resumeSession(sessionId),
            cancelSession: (sessionId: string) => coordinator.cancelSession(sessionId),
            startExecution: (sessionId: string) => coordinator.startExecution(sessionId),
            getFailedTasks: (sessionId: string) => coordinator.getFailedTasks(sessionId),
            signalAgentCompletion: (signal: any) => coordinator.signalAgentCompletion(signal),
            triggerCoordinatorEvaluation: (sessionId: string, eventType: string, payload: any) => 
                coordinator.triggerCoordinatorEvaluation(sessionId, eventType as any, payload)
        },
        planningService: {
            listPlanningSessions: () => planningService.listPlanningSessions(),
            getPlanningStatus: (id: string) => planningService.getPlanningStatus(id),
            startPlanning: async (prompt: string, docs?: string[]) => {
                const result = await planningService.startPlanning(prompt, docs);
                // Transform to match API interface
                return {
                    sessionId: result.sessionId,
                    status: result.status as string,
                    planPath: result.planPath,
                    recommendedAgents: result.recommendedAgents 
                        ? { count: result.recommendedAgents, justification: 'Auto-determined' }
                        : undefined,
                    debateSummary: result.debateSummary?.consensus
                };
            },
            revisePlan: (id: string, feedback: string) => planningService.revisePlan(id, feedback),
            approvePlan: (id: string, autoStart?: boolean) => planningService.approvePlan(id, autoStart),
            cancelPlan: (id: string) => planningService.cancelPlan(id),
            restartPlanning: (id: string) => planningService.restartPlanning(id),
            removeSession: (id: string) => planningService.removeSession(id)
        },
        // Optional services for full API support
        taskManager: (() => {
            const tm = ServiceLocator.resolve(TaskManager);
            return {
                getProgressForSession: (sessionId: string) => {
                    const progress = tm.getProgressForSession(sessionId);
                    // Map 'paused' to 'failed' for API compatibility
                    return {
                        completed: progress.completed,
                        pending: progress.pending,
                        inProgress: progress.inProgress,
                        failed: progress.paused, // TaskManager uses 'paused', API expects 'failed'
                        ready: progress.ready,
                        total: progress.total
                    };
                },
                getTasksForSession: (sessionId: string) => tm.getTasksForSession(sessionId),
                getTask: (globalTaskId: string) => tm.getTask(globalTaskId),
                markTaskFailed: (globalTaskId: string, reason?: string) => tm.markTaskFailed(globalTaskId, reason)
            };
        })(),
        roleRegistry: {
            getRole: (roleId: string) => roleRegistry.getRole(roleId),
            updateRole: (roleId: string, updates: Record<string, any>) => {
                // Get existing role, merge updates, and save
                const existing = roleRegistry.getRole(roleId);
                if (existing) {
                    const existingData = existing.toJSON() as any;
                    const updated = new AgentRole({
                        id: existing.id,
                        name: existing.name,
                        ...existingData,
                        ...updates
                    });
                    roleRegistry.updateRole(updated);
                }
            },
            resetRoleToDefault: (roleId: string) => roleRegistry.resetToDefault(roleId) !== undefined
        },
        // Unity manager - included when Unity features are enabled
        unityManager: unityManager ? {
            getState: () => unityManager!.getState(),
            queueTask: (type: string, requester: any, options?: any) => 
                unityManager!.queueTask(type as any, requester, options)
        } : undefined
    };
}

/**
 * Main entry point for standalone daemon
 */
async function main(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       APC Daemon - Standalone Mode                       ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Get workspace root from args or environment
    const workspaceRoot = process.argv[2] || process.env.APC_WORKSPACE_ROOT || findWorkspaceRoot();
    
    // Load configuration
    const configLoader = new ConfigLoader(workspaceRoot);
    const config = configLoader.getConfig();
    
    // Override with environment variables
    if (process.env.APC_PORT) {
        config.port = parseInt(process.env.APC_PORT, 10);
    }
    if (process.env.APC_POOL_SIZE) {
        config.agentPoolSize = parseInt(process.env.APC_POOL_SIZE, 10);
    }
    
    try {
        // Initialize all services
        const services = await initializeServices(config);
        
        // Create and start daemon
        const daemonOptions: DaemonOptions = {
            port: config.port,
            workspaceRoot: config.workspaceRoot,
            services,
            verbose: process.env.APC_VERBOSE === 'true'
        };
        
        const daemon = new ApcDaemon(daemonOptions);
        
        // Handle shutdown signals
        const shutdown = async (signal: string) => {
            console.log(`\n[Standalone] Received ${signal}, shutting down...`);
            await daemon.stop(signal);
            process.exit(0);
        };
        
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        
        // Start daemon
        await daemon.start();
        
        console.log('');
        console.log('[Standalone] Daemon is ready!');
        console.log(`[Standalone] WebSocket: ws://127.0.0.1:${config.port}`);
        console.log(`[Standalone] Health: http://127.0.0.1:${config.port}/health`);
        console.log('');
        console.log('[Standalone] Press Ctrl+C to stop');
        
    } catch (err) {
        console.error('[Standalone] Failed to start daemon:', err);
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main().catch(err => {
        console.error('[Standalone] Fatal error:', err);
        process.exit(1);
    });
}

export { initializeServices, main };

