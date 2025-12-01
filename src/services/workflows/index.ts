// ============================================================================
// Workflows Index - Export all workflows and registration helper
// ============================================================================

export { 
    IWorkflow, 
    WorkflowFactory, 
    WorkflowServices,
    TaskOccupancy,
    TaskConflict,
    ConflictResolution
} from './IWorkflow';
export { BaseWorkflow } from './BaseWorkflow';
export { WorkflowRegistry } from './WorkflowRegistry';

// Workflow implementations
export { PlanningNewWorkflow } from './PlanningNewWorkflow';
export { PlanningRevisionWorkflow } from './PlanningRevisionWorkflow';
export { TaskImplementationWorkflow } from './TaskImplementationWorkflow';
export { ErrorResolutionWorkflow } from './ErrorResolutionWorkflow';

// Re-export workflow types
export * from '../../types/workflow';

import { WorkflowRegistry } from './WorkflowRegistry';
import { WorkflowServices } from './IWorkflow';
import { PlanningNewWorkflow } from './PlanningNewWorkflow';
import { PlanningRevisionWorkflow } from './PlanningRevisionWorkflow';
import { TaskImplementationWorkflow } from './TaskImplementationWorkflow';
import { ErrorResolutionWorkflow } from './ErrorResolutionWorkflow';

/**
 * Register all built-in workflow types with a registry
 */
export function registerBuiltinWorkflows(registry: WorkflowRegistry): void {
    // Planning workflows
    registry.register('planning_new', (config, services) => 
        new PlanningNewWorkflow(config, services)
    );
    
    registry.register('planning_revision', (config, services) => 
        new PlanningRevisionWorkflow(config, services)
    );
    
    // Execution workflows
    registry.register('task_implementation', (config, services) => 
        new TaskImplementationWorkflow(config, services)
    );
    
    registry.register('error_resolution', (config, services) => 
        new ErrorResolutionWorkflow(config, services)
    );
    
    console.log(`[Workflows] Registered ${registry.size} workflow types`);
}

/**
 * Create a fully configured WorkflowRegistry with all built-in types
 */
export function createWorkflowRegistry(): WorkflowRegistry {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    return registry;
}

