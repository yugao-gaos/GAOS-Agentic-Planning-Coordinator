// ============================================================================
// WorkflowRegistry - Factory registry for workflow types
// ============================================================================

import { WorkflowType, WorkflowConfig } from '../../types/workflow';
import { IWorkflow, WorkflowFactory, WorkflowServices, WorkflowMetadata } from './IWorkflow';
import { Logger } from '../../utils/Logger';

const log = Logger.create('Daemon', 'WorkflowRegistry');

/**
 * Registry entry containing factory and metadata
 */
interface WorkflowRegistryEntry {
    factory: WorkflowFactory;
    metadata: WorkflowMetadata;
}

/**
 * Registry for workflow types
 * 
 * Allows new workflow types to be registered without modifying coordinator.
 * Each workflow type has a factory function that creates instances.
 */
export class WorkflowRegistry {
    private entries: Map<WorkflowType, WorkflowRegistryEntry> = new Map();
    
    /**
     * Register a workflow factory with metadata
     */
    register(type: WorkflowType, factory: WorkflowFactory, metadata?: Partial<WorkflowMetadata>): void {
        if (this.entries.has(type)) {
            log.warn(`Overwriting existing factory for: ${type}`);
        }
        
        // Build full metadata with defaults
        const fullMetadata: WorkflowMetadata = {
            type,
            name: metadata?.name || type,
            requiresUnity: metadata?.requiresUnity || false,
            requiresCompleteDependencies: metadata?.requiresCompleteDependencies ?? true, // Default: require complete deps
            coordinatorPrompt: metadata?.coordinatorPrompt || `- '${type}' - ${type} workflow`
        };
        
        this.entries.set(type, { factory, metadata: fullMetadata });
        log.debug(`Registered workflow type: ${type}`);
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
        const entry = this.entries.get(type);
        if (!entry) {
            throw new Error(`Unknown workflow type: ${type}. Available types: ${this.getTypes().join(', ')}`);
        }
        
        const fullConfig: WorkflowConfig = { ...config, type };
        return entry.factory(fullConfig, services);
    }
    
    /**
     * Check if a workflow type is registered
     */
    has(type: WorkflowType): boolean {
        return this.entries.has(type);
    }
    
    /**
     * Get metadata for a workflow type
     */
    getMetadata(type: WorkflowType): WorkflowMetadata | undefined {
        return this.entries.get(type)?.metadata;
    }
    
    /**
     * Get all registered workflow types
     */
    getTypes(): WorkflowType[] {
        return Array.from(this.entries.keys());
    }
    
    /**
     * Get all workflow metadata
     */
    getAllMetadata(): WorkflowMetadata[] {
        return Array.from(this.entries.values()).map(e => e.metadata);
    }
    
    /**
     * Get combined coordinator prompts for dispatchable workflows
     * Filters out planning workflows (triggered via UI, not coordinator)
     * 
     * @param unityEnabled Whether Unity features are enabled
     * @param userOverrides Optional user-configured prompt overrides
     */
    getCoordinatorPrompts(
        unityEnabled: boolean = true,
        userOverrides?: Record<WorkflowType, string>
    ): string {
        const prompts: string[] = [];
        
        // Planning workflows are NOT dispatchable by coordinator (triggered via UI)
        const nonDispatchableTypes = ['planning_new', 'planning_revision'];
        
        for (const entry of this.entries.values()) {
            // Skip planning workflows - coordinator doesn't dispatch these
            if (nonDispatchableTypes.includes(entry.metadata.type)) {
                continue;
            }
            
            // Skip Unity-only workflows if Unity is disabled
            if (entry.metadata.requiresUnity && !unityEnabled) {
                continue;
            }
            
            // Use user override if available, otherwise use default from metadata
            const prompt = userOverrides?.[entry.metadata.type] || entry.metadata.coordinatorPrompt;
            prompts.push(prompt);
        }
        
        return prompts.join('\n');
    }
    
    /**
     * Update the coordinator prompt for a workflow type
     * (Runtime update, doesn't persist - use WorkflowSettingsPanel for persistence)
     */
    updateCoordinatorPrompt(type: WorkflowType, prompt: string): boolean {
        const entry = this.entries.get(type);
        if (!entry) return false;
        
        entry.metadata.coordinatorPrompt = prompt;
        return true;
    }
    
    /**
     * Unregister a workflow type
     */
    unregister(type: WorkflowType): boolean {
        const existed = this.entries.has(type);
        this.entries.delete(type);
        if (existed) {
            log.debug(`Unregistered workflow type: ${type}`);
        }
        return existed;
    }
    
    /**
     * Clear all registered entries
     */
    clear(): void {
        this.entries.clear();
        log.debug(`Cleared all entries`);
    }
    
    /**
     * Get count of registered workflow types
     */
    get size(): number {
        return this.entries.size;
    }
}

