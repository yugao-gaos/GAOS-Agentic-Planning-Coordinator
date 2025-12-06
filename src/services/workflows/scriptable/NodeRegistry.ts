// ============================================================================
// NodeRegistry - Registry for node type definitions and executors
// ============================================================================

import {
    INodeDefinition,
    INodeInstance,
    INodePort,
    NodeCategory,
    NodeExecutor,
    PortDataType
} from './NodeTypes';
import { Logger } from '../../../utils/Logger';

const log = Logger.create('Daemon', 'NodeRegistry');

/**
 * Registry entry containing definition and executor
 */
interface NodeRegistryEntry {
    definition: INodeDefinition;
    executor: NodeExecutor;
}

/**
 * NodeRegistry - Central registry for all node types
 * 
 * Manages:
 * - Node type definitions (metadata, ports, config schema)
 * - Node executors (runtime behavior)
 * - Node validation
 * - Built-in and custom node types
 */
export class NodeRegistry {
    private entries: Map<string, NodeRegistryEntry> = new Map();
    private static instance: NodeRegistry | null = null;
    
    /**
     * Get singleton instance
     */
    static getInstance(): NodeRegistry {
        if (!NodeRegistry.instance) {
            NodeRegistry.instance = new NodeRegistry();
        }
        return NodeRegistry.instance;
    }
    
    /**
     * Register a node type with its definition and executor
     */
    register(definition: INodeDefinition, executor: NodeExecutor): void {
        if (this.entries.has(definition.type)) {
            log.warn(`Overwriting existing node type: ${definition.type}`);
        }
        
        // Validate definition
        this.validateDefinition(definition);
        
        this.entries.set(definition.type, { definition, executor });
        log.debug(`Registered node type: ${definition.type}`);
    }
    
    /**
     * Unregister a node type
     */
    unregister(type: string): boolean {
        const existed = this.entries.has(type);
        this.entries.delete(type);
        if (existed) {
            log.debug(`Unregistered node type: ${type}`);
        }
        return existed;
    }
    
    /**
     * Check if a node type is registered
     */
    has(type: string): boolean {
        return this.entries.has(type);
    }
    
    /**
     * Get a node definition by type
     */
    getDefinition(type: string): INodeDefinition | undefined {
        return this.entries.get(type)?.definition;
    }
    
    /**
     * Get a node executor by type
     */
    getExecutor(type: string): NodeExecutor | undefined {
        return this.entries.get(type)?.executor;
    }
    
    /**
     * Get all registered node types
     */
    getTypes(): string[] {
        return Array.from(this.entries.keys());
    }
    
    /**
     * Get all node definitions
     */
    getAllDefinitions(): INodeDefinition[] {
        return Array.from(this.entries.values()).map(e => e.definition);
    }
    
    /**
     * Get node definitions by category
     */
    getByCategory(category: NodeCategory): INodeDefinition[] {
        return this.getAllDefinitions().filter(d => d.category === category);
    }
    
    /**
     * Get all categories with their nodes (for editor palette)
     */
    getCategorizedDefinitions(): Map<NodeCategory, INodeDefinition[]> {
        const categories = new Map<NodeCategory, INodeDefinition[]>();
        
        for (const def of this.getAllDefinitions()) {
            if (!categories.has(def.category)) {
                categories.set(def.category, []);
            }
            categories.get(def.category)!.push(def);
        }
        
        return categories;
    }
    
    /**
     * Create a node instance from a definition
     */
    createInstance(
        type: string,
        id: string,
        config?: Record<string, any>,
        position?: { x: number; y: number }
    ): INodeInstance {
        const definition = this.getDefinition(type);
        if (!definition) {
            throw new Error(`Unknown node type: ${type}`);
        }
        
        // Create input ports with direction
        const inputs: INodePort[] = definition.defaultInputs.map(p => ({
            ...p,
            direction: 'input' as const
        }));
        
        // Create output ports with direction
        const outputs: INodePort[] = definition.defaultOutputs.map(p => ({
            ...p,
            direction: 'output' as const
        }));
        
        // Build default config from schema
        const defaultConfig: Record<string, any> = {};
        if (definition.configSchema) {
            for (const field of definition.configSchema.fields) {
                if (field.defaultValue !== undefined) {
                    defaultConfig[field.name] = field.defaultValue;
                }
            }
        }
        
        return {
            id,
            type,
            config: { ...defaultConfig, ...config },
            inputs,
            outputs,
            position
        };
    }
    
    /**
     * Validate a node definition
     */
    private validateDefinition(definition: INodeDefinition): void {
        if (!definition.type || typeof definition.type !== 'string') {
            throw new Error('Node definition must have a valid type string');
        }
        
        if (!definition.name || typeof definition.name !== 'string') {
            throw new Error(`Node ${definition.type}: must have a valid name`);
        }
        
        if (!definition.category) {
            throw new Error(`Node ${definition.type}: must have a category`);
        }
        
        // Validate port IDs are unique
        const portIds = new Set<string>();
        for (const port of [...definition.defaultInputs, ...definition.defaultOutputs]) {
            if (portIds.has(port.id)) {
                throw new Error(`Node ${definition.type}: duplicate port ID '${port.id}'`);
            }
            portIds.add(port.id);
        }
    }
    
    /**
     * Validate a node instance against its definition
     */
    validateInstance(instance: INodeInstance): string[] {
        const errors: string[] = [];
        const definition = this.getDefinition(instance.type);
        
        if (!definition) {
            errors.push(`Unknown node type: ${instance.type}`);
            return errors;
        }
        
        // Validate required config fields
        if (definition.configSchema) {
            for (const field of definition.configSchema.fields) {
                if (field.required && (instance.config[field.name] === undefined || instance.config[field.name] === '')) {
                    errors.push(`Node ${instance.id}: missing required config field '${field.name}'`);
                }
            }
        }
        
        // Validate config field types and constraints
        if (definition.configSchema) {
            for (const field of definition.configSchema.fields) {
                const value = instance.config[field.name];
                if (value !== undefined && value !== null) {
                    // Type validation
                    if (field.type === 'number' && typeof value !== 'number') {
                        errors.push(`Node ${instance.id}: config field '${field.name}' must be a number`);
                    }
                    if (field.type === 'boolean' && typeof value !== 'boolean') {
                        errors.push(`Node ${instance.id}: config field '${field.name}' must be a boolean`);
                    }
                    if ((field.type === 'string' || field.type === 'multiline' || field.type === 'template' || field.type === 'expression') && typeof value !== 'string') {
                        errors.push(`Node ${instance.id}: config field '${field.name}' must be a string`);
                    }
                    
                    // Range validation for numbers
                    if (field.type === 'number' && typeof value === 'number') {
                        if (field.min !== undefined && value < field.min) {
                            errors.push(`Node ${instance.id}: config field '${field.name}' must be >= ${field.min}`);
                        }
                        if (field.max !== undefined && value > field.max) {
                            errors.push(`Node ${instance.id}: config field '${field.name}' must be <= ${field.max}`);
                        }
                    }
                    
                    // Pattern validation for strings
                    if (field.pattern && typeof value === 'string') {
                        const regex = new RegExp(field.pattern);
                        if (!regex.test(value)) {
                            errors.push(`Node ${instance.id}: config field '${field.name}' does not match pattern`);
                        }
                    }
                    
                    // Select validation
                    if (field.type === 'select' && field.options) {
                        const validValues = field.options.map(o => o.value);
                        if (!validValues.includes(value)) {
                            errors.push(`Node ${instance.id}: config field '${field.name}' must be one of: ${validValues.join(', ')}`);
                        }
                    }
                }
            }
        }
        
        return errors;
    }
    
    /**
     * Check if two port types are compatible for connection
     */
    arePortsCompatible(sourceType: PortDataType, targetType: PortDataType): boolean {
        // 'any' is compatible with everything
        if (sourceType === 'any' || targetType === 'any') {
            return true;
        }
        
        // 'trigger' only connects to 'trigger'
        if (sourceType === 'trigger' || targetType === 'trigger') {
            return sourceType === targetType;
        }
        
        // Direct type match
        if (sourceType === targetType) {
            return true;
        }
        
        // Number/string/boolean can convert to each other in expressions
        const primitives: PortDataType[] = ['string', 'number', 'boolean'];
        if (primitives.includes(sourceType) && primitives.includes(targetType)) {
            return true;
        }
        
        // Object/array are compatible (weak typing)
        if ((sourceType === 'object' || sourceType === 'array') && 
            (targetType === 'object' || targetType === 'array')) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Clear all registered node types
     */
    clear(): void {
        this.entries.clear();
        log.debug('Cleared all node types');
    }
    
    /**
     * Get count of registered types
     */
    get size(): number {
        return this.entries.size;
    }
}

/**
 * Export singleton instance for convenience
 */
export const nodeRegistry = NodeRegistry.getInstance();

