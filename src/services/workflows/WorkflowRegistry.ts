// ============================================================================
// WorkflowRegistry - Factory registry for workflow types
// ============================================================================

import { WorkflowType, WorkflowConfig } from '../../types/workflow';
import { IWorkflow, WorkflowFactory, WorkflowServices } from './IWorkflow';

/**
 * Registry for workflow types
 * 
 * Allows new workflow types to be registered without modifying coordinator.
 * Each workflow type has a factory function that creates instances.
 */
export class WorkflowRegistry {
    private factories: Map<WorkflowType, WorkflowFactory> = new Map();
    
    /**
     * Register a workflow factory for a given type
     */
    register(type: WorkflowType, factory: WorkflowFactory): void {
        if (this.factories.has(type)) {
            console.warn(`[WorkflowRegistry] Overwriting existing factory for: ${type}`);
        }
        this.factories.set(type, factory);
        console.log(`[WorkflowRegistry] Registered workflow type: ${type}`);
    }
    
    /**
     * Create a workflow instance
     * 
     * @param type Workflow type to create
     * @param config Configuration without type (type is added automatically)
     * @param services Injected services
     * @returns Created workflow instance
     * @throws Error if workflow type is not registered
     */
    create(
        type: WorkflowType,
        config: Omit<WorkflowConfig, 'type'>,
        services: WorkflowServices
    ): IWorkflow {
        const factory = this.factories.get(type);
        if (!factory) {
            throw new Error(`Unknown workflow type: ${type}. Available types: ${this.getTypes().join(', ')}`);
        }
        
        const fullConfig: WorkflowConfig = { ...config, type };
        return factory(fullConfig, services);
    }
    
    /**
     * Check if a workflow type is registered
     */
    has(type: WorkflowType): boolean {
        return this.factories.has(type);
    }
    
    /**
     * Get all registered workflow types
     */
    getTypes(): WorkflowType[] {
        return Array.from(this.factories.keys());
    }
    
    /**
     * Unregister a workflow type
     */
    unregister(type: WorkflowType): boolean {
        const existed = this.factories.has(type);
        this.factories.delete(type);
        if (existed) {
            console.log(`[WorkflowRegistry] Unregistered workflow type: ${type}`);
        }
        return existed;
    }
    
    /**
     * Clear all registered factories
     */
    clear(): void {
        this.factories.clear();
        console.log(`[WorkflowRegistry] Cleared all factories`);
    }
    
    /**
     * Get count of registered workflow types
     */
    get size(): number {
        return this.factories.size;
    }
}

