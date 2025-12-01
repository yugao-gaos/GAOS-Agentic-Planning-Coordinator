/**
 * Bootstrap.ts - Service registration in dependency order
 * 
 * This module registers all services with the ServiceLocator in the correct
 * dependency order. Services at lower levels are registered first so they
 * can be resolved by services at higher levels.
 * 
 * Dependency Levels:
 * - Level 0: No dependencies (OutputChannelManager, EventBroadcaster, etc.)
 * - Level 1: Depends on Level 0 (ProcessManager, TaskManager)
 * - Level 2: Depends on Level 1 (CursorAgentRunner, WorkflowPauseManager)
 * - Level 3: Depends on Level 2 (AgentRunner, UnityControlManager)
 * - Level 4: UnifiedCoordinatorService - requires external deps, registered in extension.ts
 * 
 * Usage:
 *   import { bootstrapServices } from './services/Bootstrap';
 *   bootstrapServices();
 */

import { ServiceLocator } from './ServiceLocator';

// Level 0 - No dependencies
import { OutputChannelManager } from './OutputChannelManager';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { PlanCache } from './PlanCache';
import { ErrorClassifier } from './workflows/ErrorClassifier';
import { DependencyService } from './DependencyService';

// Level 1 - Depends on Level 0
import { ProcessManager } from './ProcessManager';
import { TaskManager } from './TaskManager';

// Level 2 - Depends on Level 1
import { CursorAgentRunner } from './CursorAgentRunner';
import { WorkflowPauseManager } from './workflows/WorkflowPauseManager';

// Level 3 - Depends on Level 2
import { AgentRunner } from './AgentBackend';
import { UnityControlManager } from './UnityControlManager';

/**
 * Bootstrap all services with the ServiceLocator
 * 
 * Call this during extension activation, before any services are used.
 * Services are registered in dependency order so that when a service
 * is instantiated, its dependencies are already registered.
 * 
 * Note: UnifiedCoordinatorService is NOT registered here because it requires
 * external dependencies (StateManager, AgentPoolService, AgentRoleRegistry)
 * that are created in extension.ts. Register it manually after those are ready.
 */
export function bootstrapServices(): void {
    // Prevent double initialization
    if (ServiceLocator.isInitialized()) {
        console.log('[Bootstrap] Services already initialized, skipping');
        return;
    }

    console.log('[Bootstrap] Registering services...');

    // ========================================================================
    // Level 0 - No dependencies
    // ========================================================================
    
    ServiceLocator.register(OutputChannelManager, () => new OutputChannelManager());
    ServiceLocator.register(EventBroadcaster, () => new EventBroadcaster());
    ServiceLocator.register(PlanCache, () => new PlanCache());
    ServiceLocator.register(ErrorClassifier, () => new ErrorClassifier());
    ServiceLocator.register(DependencyService, () => new DependencyService());

    // ========================================================================
    // Level 1 - Depends on Level 0
    // ========================================================================
    
    ServiceLocator.register(ProcessManager, () => new ProcessManager());
    ServiceLocator.register(TaskManager, () => new TaskManager());

    // ========================================================================
    // Level 2 - Depends on Level 1
    // ========================================================================
    
    ServiceLocator.register(CursorAgentRunner, () => new CursorAgentRunner());
    ServiceLocator.register(WorkflowPauseManager, () => new WorkflowPauseManager());

    // ========================================================================
    // Level 3 - Depends on Level 2
    // ========================================================================
    
    ServiceLocator.register(AgentRunner, () => new AgentRunner());
    ServiceLocator.register(UnityControlManager, () => new UnityControlManager());

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
    console.log('[Bootstrap] Services registered:', ServiceLocator.getRegisteredServices().join(', '));
}

/**
 * Re-export ServiceLocator for convenience
 */
export { ServiceLocator } from './ServiceLocator';

