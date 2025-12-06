// ============================================================================
// Workflows Index - Export all workflows and registration helper
// ============================================================================

export { 
    IWorkflow, 
    WorkflowFactory, 
    WorkflowServices,
    WorkflowMetadata,
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
export { ContextGatheringWorkflow } from './ContextGatheringWorkflow';

// Re-export workflow types
export * from '../../types/workflow';

import { WorkflowRegistry } from './WorkflowRegistry';
import { WorkflowServices } from './IWorkflow';
import { PlanningNewWorkflow } from './PlanningNewWorkflow';
import { PlanningRevisionWorkflow } from './PlanningRevisionWorkflow';
import { Logger } from '../../utils/Logger';

const log = Logger.create('Daemon', 'Workflows');
import { TaskImplementationWorkflow } from './TaskImplementationWorkflow';
import { ErrorResolutionWorkflow } from './ErrorResolutionWorkflow';
import { ContextGatheringWorkflow } from './ContextGatheringWorkflow';
import { DEFAULT_WORKFLOW_METADATA } from '../WorkflowSettingsManager';

/**
 * Register all built-in workflow types with a registry
 * 
 * Uses DEFAULT_WORKFLOW_METADATA from WorkflowSettingsManager as the single
 * source of truth for workflow names, descriptions, and coordinator prompts.
 */
export function registerBuiltinWorkflows(registry: WorkflowRegistry): void {
    // Planning workflows
    registry.register(
        'planning_new',
        (config, services) => new PlanningNewWorkflow(config, services),
        DEFAULT_WORKFLOW_METADATA.planning_new
    );
    
    registry.register(
        'planning_revision',
        (config, services) => new PlanningRevisionWorkflow(config, services),
        DEFAULT_WORKFLOW_METADATA.planning_revision
    );
    
    // Execution workflows
    registry.register(
        'task_implementation',
        (config, services) => new TaskImplementationWorkflow(config, services),
        DEFAULT_WORKFLOW_METADATA.task_implementation
    );
    
    registry.register(
        'error_resolution',
        (config, services) => new ErrorResolutionWorkflow(config, services),
        DEFAULT_WORKFLOW_METADATA.error_resolution
    );
    
    // Context workflows
    registry.register(
        'context_gathering',
        (config, services) => new ContextGatheringWorkflow(config, services),
        DEFAULT_WORKFLOW_METADATA.context_gathering
    );
    
    log.info(`Registered ${registry.size} built-in workflow types`);
}

// Export ScriptableWorkflowRegistry for dynamic custom workflows
export { ScriptableWorkflowRegistry } from './ScriptableWorkflowRegistry';

// Export scriptable node workflow system
export * from './scriptable';

/**
 * Create a fully configured WorkflowRegistry with all built-in types
 */
export function createWorkflowRegistry(): WorkflowRegistry {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    return registry;
}

