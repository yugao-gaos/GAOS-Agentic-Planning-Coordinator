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
import { ProcessManager } from '../services/ProcessManager';
import { UnityControlManager } from '../services/UnityControlManager';
import { bootstrapDaemonServices, ServiceLocator } from '../services/DaemonBootstrap';
import { EventBroadcaster } from './EventBroadcaster';
import { DependencyService } from '../services/DependencyService';
import { ScriptableWorkflowRegistry } from '../services/workflows/ScriptableWorkflowRegistry';
import { Logger } from '../utils/Logger';
import * as path from 'path';

const log = Logger.create('Daemon', 'Standalone');

/**
 * Initialize all services for standalone daemon mode
 * @param daemon The daemon instance (so we can signal when services are ready)
 */
async function initializeServices(config: CoreConfig, daemon?: ApcDaemon): Promise<ApiServices> {
    log.info('Initializing services...');
    log.info(`Workspace: ${config.workspaceRoot}`);
    log.info(`Working directory: _AiDevLog (standard)`);
    log.info(`Agent pool size: ${config.agentPoolSize}`);
    
    // Get broadcaster early so we can send progress updates
    // Note: EventBroadcaster is registered by bootstrapDaemonServices()
    const broadcastProgress = (step: string, phase: 'checking_dependencies' | 'initializing_services' | 'ready' = 'initializing_services') => {
        try {
            if (ServiceLocator.isRegistered(EventBroadcaster)) {
                const broadcaster = ServiceLocator.resolve(EventBroadcaster);
                broadcaster.broadcast('daemon.progress' as any, {
                    step,
                    phase,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (e) {
            // Silently ignore errors in progress broadcasting
        }
    };
    
    // Bootstrap all services with ServiceLocator
    // This registers AgentRunner and other services needed for dependency checks
    broadcastProgress('Bootstrapping services');
    bootstrapDaemonServices();
    
    // Kill orphan agent processes using backend abstraction
    // Check if AgentRunner is registered (it should be after bootstrapDaemonServices)
    if (ServiceLocator.isRegistered(AgentRunner)) {
        log.info('Cleaning up orphan agent processes...');
        broadcastProgress('Cleaning up orphan processes');
        const agentRunner = ServiceLocator.resolve(AgentRunner);
        const killedCount = await agentRunner.killOrphanAgents();
        if (killedCount > 0) {
            log.info(`Killed ${killedCount} orphan processes`);
        } else {
            log.info('No orphan processes found');
        }
    }
    
    // Initialize output channel manager (file-only mode for standalone)
    const outputManager = ServiceLocator.resolve(OutputChannelManager);
    outputManager.setOutputTarget('file');
    
    // Initialize StateManager
    broadcastProgress('Initializing StateManager');
    const stateManagerConfig: StateManagerConfig = {
        workspaceRoot: config.workspaceRoot,
        agentPoolSize: config.agentPoolSize,
        defaultBackend: config.defaultBackend
    };
    
    const stateManager = new StateManager(stateManagerConfig);
    await stateManager.initialize();
    ServiceLocator.register(StateManager, () => stateManager);
    log.info(`StateManager initialized with ${stateManager.getAllPlanningSessions().length} sessions`);
    
    // Reload persisted tasks now that StateManager is available
    broadcastProgress('Reloading persisted tasks');
    const taskManager = ServiceLocator.resolve(TaskManager);
    taskManager.reloadPersistedTasks();
    log.info(`TaskManager reloaded ${taskManager.getAllTasks().length} persisted tasks`);
    
    // Initialize AgentRoleRegistry
    broadcastProgress('Initializing AgentRoleRegistry');
    const roleRegistry = new AgentRoleRegistry(stateManager);
    // Unity features enabled by default (can be disabled via config or APC_ENABLE_UNITY=false)
    const enableUnity = config.enableUnityFeatures;
    roleRegistry.setUnityEnabled(enableUnity);
    log.info(`AgentRoleRegistry initialized, Unity: ${enableUnity ? 'enabled' : 'disabled'}`);
    
    // Initialize AgentPoolService
    broadcastProgress('Initializing AgentPoolService');
    const agentPoolService = new AgentPoolService(stateManager, roleRegistry);
    ServiceLocator.register(AgentPoolService, () => agentPoolService);
    log.info(`AgentPoolService initialized with ${agentPoolService.getPoolStatus().total} agents`);
    
    // Initialize HeadlessTerminalManager (no-op for standalone)
    const terminalManager = new HeadlessTerminalManager();
    
    // Initialize AgentRunner with default backend
    broadcastProgress('Initializing AgentRunner');
    const agentRunner = ServiceLocator.resolve(AgentRunner);
    agentRunner.setBackend(config.defaultBackend);
    log.info(`AgentRunner initialized with backend: ${config.defaultBackend}`);
    
    // Initialize UnityControlManager if Unity is enabled
    let unityManager: UnityControlManager | undefined;
    if (enableUnity) {
        broadcastProgress('Initializing UnityControlManager');
        unityManager = ServiceLocator.resolve(UnityControlManager);
        unityManager.setAgentRoleRegistry(roleRegistry);
        await unityManager.initialize(config.workspaceRoot);
        log.info('UnityControlManager initialized');
    }
    
    // Register and initialize UnifiedCoordinatorService
    broadcastProgress('Initializing UnifiedCoordinatorService');
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
    
    // ==========================================================================
    // WORKFLOW RECOVERY: Restore paused workflows from previous daemon session
    // ==========================================================================
    broadcastProgress('Recovering paused workflows');
    
    // Get all non-completed sessions and restore their paused workflows
    const allSessions = stateManager.getAllPlanningSessions();
    const activeSessions = allSessions.filter(s => s.status !== 'completed');
    
    // Initialize each active session (this triggers workflow restoration)
    for (const session of activeSessions) {
        coordinator.getSessionState(session.id); // Auto-initializes and restores workflows
    }
    
    // Collect all valid workflow IDs from restored workflows
    const validWorkflowIds = new Set<string>();
    for (const session of activeSessions) {
        const sessionState = coordinator.getSessionState(session.id);
        if (sessionState?.activeWorkflows) {
            for (const workflowId of sessionState.activeWorkflows.keys()) {
                validWorkflowIds.add(workflowId);
            }
        }
    }
    
    // Release any agents allocated to workflows that couldn't be restored
    const releasedOrphans = agentPoolService.releaseOrphanAllocatedAgents(validWorkflowIds);
    if (releasedOrphans.length > 0) {
        log.info(`Released ${releasedOrphans.length} orphan agent(s) from dead workflows`);
    }
    
    log.info(`Workflow recovery complete: ${validWorkflowIds.size} workflows active across ${activeSessions.length} sessions`);
    // ==========================================================================
    
    // Subscribe to agent allocation events and broadcast to clients
    const broadcaster = ServiceLocator.resolve(EventBroadcaster);
    coordinator.onAgentAllocated(({ agentName, sessionId, roleId, workflowId }) => {
        log.debug(`onAgentAllocated: agent=${agentName}, session=${sessionId}, role=${roleId}, workflow=${workflowId}`);
        
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
            const allocatedAgents = agentPoolService.getAllocatedAgents();
            const busyAgents = agentPoolService.getBusyAgents();
            const restingAgents = agentPoolService.getRestingAgents();
            log.debug(`Broadcasting pool.changed after allocation: available=${poolStatus.available.length}, allocated=${allocatedAgents.length}, busy=${busyAgents.length}, resting=${restingAgents.length}`);
            broadcaster.poolChanged(
                poolStatus.total,
                poolStatus.available,
                allocatedAgents.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId })),
                busyAgents.map(b => ({ name: b.name, coordinatorId: b.workflowId || '', roleId: b.roleId })),
                restingAgents
            );
        } catch (e) {
            log.error(`Error in onAgentAllocated handler:`, e);
            
            // Still try to broadcast pool.changed even if other parts failed
            try {
                const poolStatus = agentPoolService.getPoolStatus();
                const allocatedAgents = agentPoolService.getAllocatedAgents();
                const busyAgents = agentPoolService.getBusyAgents();
                const restingAgents = agentPoolService.getRestingAgents();
                broadcaster.poolChanged(
                    poolStatus.total,
                    poolStatus.available,
                    allocatedAgents.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId })),
                    busyAgents.map(b => ({ name: b.name, coordinatorId: b.workflowId || '', roleId: b.roleId })),
                    restingAgents
                );
            } catch (e2) {
                log.error(`Failed to broadcast pool.changed:`, e2);
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
        const allocatedAgents2 = agentPoolService.getAllocatedAgents();
        const busyAgents2 = agentPoolService.getBusyAgents();
        const restingAgents2 = agentPoolService.getRestingAgents();
        broadcaster.poolChanged(
            poolStatus2.total,
            poolStatus2.available,
            allocatedAgents2.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId })),
            busyAgents2.map(b => ({ name: b.name, coordinatorId: b.workflowId || '', roleId: b.roleId })),
            restingAgents2
        );
    });
    
    // Subscribe to coordinator status changes and broadcast to clients
    // This enables real-time UI updates showing coordinator state (idle, evaluating, etc.)
    coordinator.onCoordinatorStatusChanged((status) => {
        broadcaster.coordinatorStatusChanged(
            status.state,
            status.pendingEvents,
            status.evaluationCount,
            status.lastEvaluation
        );
    });
    
    log.info('UnifiedCoordinatorService initialized');
    
    // Initialize ScriptableWorkflowRegistry for custom YAML workflows
    broadcastProgress('Initializing ScriptableWorkflowRegistry');
    const workflowsPath = path.join(config.workspaceRoot, '_AiDevLog', 'Workflows');
    const scriptableRegistry = new ScriptableWorkflowRegistry(
        coordinator.getWorkflowRegistry(),
        workflowsPath
    );
    await scriptableRegistry.initialize();
    scriptableRegistry.startWatching(); // Enable hot-reload on file changes
    ServiceLocator.register(ScriptableWorkflowRegistry, () => scriptableRegistry);
    log.info(`ScriptableWorkflowRegistry initialized with ${scriptableRegistry.getCustomWorkflowTypes().length} custom workflows`);
    
    // Note: Session recovery is now handled automatically by initSession() 
    // which calls restorePausedWorkflows() for each active session
    
    // Initialize PlanningService
    const planningService = new PlanningService(stateManager, coordinator, {});
    log.info('PlanningService initialized');
    
    // Initialize and start IdlePlanMonitor
    const { IdlePlanMonitor } = await import('./IdlePlanMonitor');
    const idlePlanMonitor = new IdlePlanMonitor(stateManager, agentPoolService, coordinator);
    idlePlanMonitor.setOutputManager(outputManager);
    idlePlanMonitor.start();
    log.info('IdlePlanMonitor started');
    
    // ========================================================================
    // DEPENDENCY CHECK - After all services are initialized
    // ========================================================================
    // Now that AgentRunner is registered and available, we can run full dependency checks
    // including MCP connectivity tests that require spawning agents
    log.info('Checking system dependencies...');
    const dependencyService = ServiceLocator.resolve(DependencyService);
    dependencyService.setWorkspaceRoot(config.workspaceRoot);
    dependencyService.setUnityEnabled(config.enableUnityFeatures);
    
    // No more auto-sync on every daemon start!
    // User installs Unity MCP once (via UI button or manually), then it works forever
    // URL is always localhost:8080 (mirrored mode is REQUIRED)
    
    // Set up progress broadcasting callback (reuse broadcaster from earlier)
    dependencyService.setProgressCallback((name, status) => {
        // Broadcast each dependency check result to connected clients in real-time
        broadcaster.broadcast('deps.progress' as any, { name, status });
    });
    
    // Broadcast the full list of dependencies upfront so UI can show all items
    const dependencyList = dependencyService.getDependencyList();
    broadcaster.broadcast('deps.list' as any, { dependencies: dependencyList });
    log.debug(`Broadcasting dependency list: ${dependencyList.join(', ')}`);
    
    broadcastProgress('Checking system dependencies', 'checking_dependencies');
    const depStatuses = await dependencyService.checkAllDependencies();
    
    // Analyze dependency status
    const platform = process.platform;
    const relevantDeps = depStatuses.filter(d => d.platform === platform || d.platform === 'all');
    const missingDeps = relevantDeps.filter(d => d.required && !d.installed);
    const criticalMissing = missingDeps.filter(d => 
        d.name.includes('Python') || d.name.includes('APC CLI')
    );
    
    if (missingDeps.length > 0) {
        log.warn(`⚠️  Missing dependencies (${missingDeps.length}):`);
        for (const dep of missingDeps) {
            log.warn(`  ❌ ${dep.name}: ${dep.description}`);
        }
        if (criticalMissing.length > 0) {
            log.warn(`⚠️  ${criticalMissing.length} critical dependencies missing - some operations BLOCKED!`);
        }
        
        // System is "ready" but with missing dependencies
        // This means the daemon works, but some features won't work
        idlePlanMonitor.setSystemReady();
        log.warn(`⚠️  System ready with ${missingDeps.length} missing dependencies - some features unavailable`);
        log.info('💡 Use the GUI to install missing dependencies');
    } else {
        log.info('✅ All dependencies satisfied');
        
        // Signal system ready - all services initialized and dependencies OK
        idlePlanMonitor.setSystemReady();
        log.info('✅ System fully ready - all dependencies satisfied');
    }
    
    // Signal daemon that services are ready (daemon itself is always ready, dependencies may not be)
    if (daemon) {
        daemon.setServicesReady();
    }
    
    // Return API services interface
    return {
        stateManager: {
            getAllPlanningSessions: () => stateManager.getAllPlanningSessions(),
            getPlanningSession: (id: string) => stateManager.getPlanningSession(id),
            deletePlanningSession: (id: string) => stateManager.deletePlanningSession(id),
            getSessionTasksFilePath: (sessionId: string) => stateManager.getSessionTasksFilePath(sessionId),
            getWorkspaceRoot: () => stateManager.getWorkspaceRoot(),
            getWorkingDir: () => stateManager.getWorkingDir(),
            getPlansDirectory: () => stateManager.getPlansDirectory()
        },
        agentPoolService: {
            getPoolStatus: () => agentPoolService.getPoolStatus(),
            getAvailableAgents: () => agentPoolService.getAvailableAgents(),
            getAllocatedAgents: () => agentPoolService.getAllocatedAgents(),
            getBusyAgents: () => agentPoolService.getBusyAgents().map(b => ({
                name: b.name,
                roleId: b.roleId,
                coordinatorId: b.workflowId || '',
                sessionId: b.sessionId,
                task: b.task
            })),
            getRestingAgents: () => agentPoolService.getRestingAgents(),
            getAgentsOnBench: (sessionId?: string) => agentPoolService.getAgentsOnBench(sessionId),
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
            pauseWorkflow: (sessionId: string, workflowId: string) => coordinator.pauseWorkflow(sessionId, workflowId),
            resumeWorkflow: (sessionId: string, workflowId: string) => coordinator.resumeWorkflow(sessionId, workflowId),
            pauseSession: (sessionId: string) => coordinator.pauseSession(sessionId),
            resumeSession: (sessionId: string) => coordinator.resumeSession(sessionId),
            cancelSession: (sessionId: string) => coordinator.cancelSession(sessionId),
            startExecution: (sessionId: string) => coordinator.startExecution(sessionId),
            getFailedTasks: (sessionId: string) => coordinator.getFailedTasks(sessionId),
            signalAgentCompletion: (signal: any) => coordinator.signalAgentCompletion(signal),
            triggerCoordinatorEvaluation: (sessionId: string, eventType: string, payload: any) => 
                coordinator.triggerCoordinatorEvaluation(sessionId, eventType as any, payload),
            updateWorkflowHistorySummary: (sessionId: string, workflowId: string, summary: string) =>
                coordinator.updateWorkflowHistorySummary(sessionId, workflowId, summary),
            startTaskWorkflow: (sessionId: string, taskId: string, workflowType: string) =>
                coordinator.startTaskWorkflow(sessionId, taskId, workflowType),
            // Stale workflow cleanup
            forceCleanupStaleWorkflows: (sessionId: string) => coordinator.forceCleanupStaleWorkflows(sessionId),
            forceCleanupAllStaleWorkflows: () => coordinator.forceCleanupAllStaleWorkflows(),
            // Graceful shutdown
            gracefulShutdown: () => coordinator.gracefulShutdown()
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
        processManager: {
            killOrphanCursorAgents: async () => {
                const pm = ServiceLocator.resolve(ProcessManager);
                return await pm.killOrphanCursorAgents();
            }
        },
        // Optional services for full API support
        // Use lazy resolution (resolve on each call) to avoid initialization order issues
        taskManager: {
            getProgressForSession: (sessionId: string) => {
                const tm = ServiceLocator.resolve(TaskManager);
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
            getTasksForSession: (sessionId: string) => ServiceLocator.resolve(TaskManager).getTasksForSession(sessionId),
            getTask: (globalTaskId: string) => ServiceLocator.resolve(TaskManager).getTask(globalTaskId),
            getAllTasks: () => ServiceLocator.resolve(TaskManager).getAllTasks(),
            createTaskFromCli: (params: { sessionId: string; taskId: string; description: string; dependencies?: string[]; taskType?: 'implementation' | 'error_fix'; priority?: number; errorText?: string }) => 
                ServiceLocator.resolve(TaskManager).createTaskFromCli(params),
            completeTask: (globalTaskId: string, summary?: string) => ServiceLocator.resolve(TaskManager).markTaskCompletedViaCli(globalTaskId, summary),
            updateTaskStage: (globalTaskId: string, stage: string) => ServiceLocator.resolve(TaskManager).updateTaskStage(globalTaskId, stage),
            markTaskFailed: (globalTaskId: string, reason?: string) => ServiceLocator.resolve(TaskManager).markTaskFailed(globalTaskId, reason),
            deleteTask: (globalTaskId: string, reason?: string) => ServiceLocator.resolve(TaskManager).deleteTask(globalTaskId, reason),
            validateTaskFormat: (task: any) => ServiceLocator.resolve(TaskManager).validateTaskFormat(task),
            reloadPersistedTasks: () => ServiceLocator.resolve(TaskManager).reloadPersistedTasks(),
            getAgentAssignmentsForUI: () => ServiceLocator.resolve(TaskManager).getAgentAssignmentsForUI?.() || [],
            addDependency: (taskId: string, dependsOnId: string) => ServiceLocator.resolve(TaskManager).addDependency(taskId, dependsOnId),
            removeDependency: (taskId: string, depId: string) => ServiceLocator.resolve(TaskManager).removeDependency(taskId, depId)
        },
        roleRegistry: {
            getRole: (roleId: string) => roleRegistry.getRole(roleId),
            getAllRoles: () => roleRegistry.getAllRoles(),
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
            resetRoleToDefault: (roleId: string) => roleRegistry.resetToDefault(roleId) !== undefined,
            getAllSystemPrompts: () => roleRegistry.getAllSystemPrompts(),
            getSystemPrompt: (id: string) => roleRegistry.getSystemPrompt(id),
            updateSystemPrompt: (config: any) => roleRegistry.updateSystemPrompt(config),
            resetSystemPromptToDefault: (promptId: string) => roleRegistry.resetSystemPromptToDefault(promptId),
            // Polling prompt methods
            getPollingPrompt: () => roleRegistry.getPollingPrompt(),
            updatePollingPrompt: (prompt: string) => roleRegistry.updatePollingPrompt(prompt),
            resetPollingPromptToDefault: () => roleRegistry.resetPollingPromptToDefault()
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
        // Create daemon first (without services)
        const daemonOptions: DaemonOptions = {
            port: config.port,
            workspaceRoot: config.workspaceRoot,
            services: undefined,  // Services initialized below
            verbose: process.env.APC_VERBOSE === 'true'
        };
        
        const daemon = new ApcDaemon(daemonOptions);
        
        // Start daemon WebSocket server
        await daemon.start();
        log.info(`Daemon WebSocket server started on port ${config.port}`);
        
        // Now initialize all services (passing daemon so it can be marked ready)
        const services = await initializeServices(config, daemon);
        
        // Register services with daemon
        daemon.setServices(services);
        
        // Handle shutdown signals
        const shutdown = async (signal: string) => {
            log.info(`Received ${signal}, shutting down...`);
            await daemon.stop(signal);
            process.exit(0);
        };
        
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        
        console.log('');
        log.info('Daemon is ready!');
        log.info(`WebSocket: ws://127.0.0.1:${config.port}`);
        log.info(`Health: http://127.0.0.1:${config.port}/health`);
        console.log('');
        log.info('Press Ctrl+C to stop');
        
    } catch (err) {
        log.error('Failed to start daemon:', err);
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main().catch(err => {
        log.error('Fatal error:', err);
        process.exit(1);
    });
}

export { initializeServices, main };

