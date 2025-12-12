/**
 * DaemonBootstrap.ts - Service registration for DAEMON ONLY
 * 
 * ⚠️ DAEMON-ONLY: This module is ONLY called by the daemon (standalone.ts, start.ts)
 * ⚠️ NEVER import this in extension.ts - extension is a pure GUI client
 * 
 * This module registers all core business logic services with the ServiceLocator
 * in the correct dependency order. Services at lower levels are registered first
 * so they can be resolved by services at higher levels.
 * 
 * Dependency Levels:
 * - Level 0: No dependencies (OutputChannelManager, EventBroadcaster, etc.)
 * - Level 1: Depends on Level 0 (ProcessManager, TaskManager)
 * - Level 2: Depends on Level 1 (CursorAgentRunner)
 * - Level 3: Depends on Level 2 (AgentRunner, UnityControlManager)
 * - Level 4: UnifiedCoordinatorService - requires external deps, registered in standalone.ts
 * 
 * Usage (DAEMON ONLY):
 *   import { bootstrapDaemonServices } from './services/DaemonBootstrap';
 *   bootstrapDaemonServices();
 */

import { ServiceLocator } from './ServiceLocator';

// Level 0 - No dependencies
import { OutputChannelManager } from './OutputChannelManager';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { PlanCache } from './PlanCache';
import { ErrorClassifier } from './workflows/ErrorClassifier';
import { DependencyService } from './DependencyService';
import { TaskIdValidator } from './TaskIdValidator';

// Level 1 - Depends on Level 0
import { ProcessManager } from './ProcessManager';
import { TaskManager } from './TaskManager';

// Level 2 - Depends on Level 1
// Note: Individual backend runners (CursorAgentRunner, ClaudeAgentRunner, CodexAgentRunner)
// are registered via AgentRunner.bootstrapBackends() to keep abstraction clean

// Level 3 - Depends on Level 2
import { AgentRunner } from './AgentBackend';
import { UnityControlManager } from './UnityControlManager';
import { TaskAgent } from './TaskAgent';

/**
 * Bootstrap all DAEMON services with the ServiceLocator
 * 
 * ⚠️ DAEMON-ONLY: Call this ONLY in daemon startup (standalone.ts, start.ts)
 * ⚠️ NEVER call from extension.ts - extension is a pure GUI client
 * 
 * Services are registered in dependency order so that when a service
 * is instantiated, its dependencies are already registered.
 * 
 * Note: UnifiedCoordinatorService is NOT registered here because it requires
 * external dependencies (StateManager, AgentPoolService, AgentRoleRegistry)
 * that are created in standalone.ts. Register it there after those are ready.
 */
export function bootstrapDaemonServices(): void {
    // Prevent double initialization
    if (ServiceLocator.isInitialized()) {
        console.log('[DaemonBootstrap] Services already initialized, skipping');
        return;
    }

    console.log('[DaemonBootstrap] Registering daemon services...');

    // ========================================================================
    // Level 0 - No dependencies
    // ========================================================================
    
    ServiceLocator.register(OutputChannelManager, () => new OutputChannelManager());
    ServiceLocator.register(EventBroadcaster, () => new EventBroadcaster());
    ServiceLocator.register(PlanCache, () => new PlanCache());
    ServiceLocator.register(ErrorClassifier, () => new ErrorClassifier());
    ServiceLocator.register(DependencyService, () => new DependencyService());
    ServiceLocator.register(TaskIdValidator, () => new TaskIdValidator());

    // ========================================================================
    // Level 1 - Depends on Level 0
    // ========================================================================
    
    ServiceLocator.register(ProcessManager, () => new ProcessManager());
    ServiceLocator.register(TaskManager, () => new TaskManager());

    // ========================================================================
    // Level 2 & 3 - Agent Backend Services
    // ========================================================================
    // All backend runners are registered via AgentRunner.bootstrapBackends()
    // This keeps the abstraction clean - DaemonBootstrap only knows about AgentRunner
    AgentRunner.bootstrapBackends();
    
    // ========================================================================
    // Level 3 - Depends on Level 2
    // ========================================================================
    
    ServiceLocator.register(UnityControlManager, () => new UnityControlManager());
    ServiceLocator.register(TaskAgent, () => new TaskAgent());

    // ========================================================================
    // Level 4 - UnifiedCoordinatorService
    // ========================================================================
    // NOT registered here - requires StateManager, AgentPoolService, AgentRoleRegistry
    // which are created in extension.ts. Register it there after those are ready:
    //
    // ServiceLocator.register(UnifiedCoordinatorService, () => 
    //     new UnifiedCoordinatorService(stateManager, agentPoolService, agentRoleRegistry)
    // );

    ServiceLocator.markInitialized();
    console.log('[DaemonBootstrap] Daemon services registered:', ServiceLocator.getRegisteredServices().join(', '));
}

/**
 * Re-export ServiceLocator for convenience
 */
export { ServiceLocator } from './ServiceLocator';

