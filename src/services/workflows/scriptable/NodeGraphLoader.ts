// ============================================================================
// NodeGraphLoader - YAML parser and validator for node graphs
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { 
    INodeGraph, 
    INodeInstance, 
    INodeConnection,
    IWorkflowParameter,
    IWorkflowVariable,
    INodePort,
    INodeErrorConfig
} from './NodeTypes';
import { nodeRegistry } from './NodeRegistry';
import { Logger } from '../../../utils/Logger';

const log = Logger.create('Daemon', 'NodeGraphLoader');

/**
 * Validation error with details
 */
export interface ValidationError {
    type: 'error' | 'warning';
    message: string;
    path?: string;
    nodeId?: string;
    connectionId?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationError[];
}

/**
 * Raw YAML node structure before parsing
 */
interface RawYamlNode {
    id: string;
    type: string;
    config?: Record<string, any>;
    inputs?: Array<{
        port: string;
        from?: string;
        type?: string;
    }>;
    outputs?: Array<{
        port: string;
        type?: string;
    }>;
    timeout_ms?: number;
    on_error?: {
        strategy: string;
        max_retries?: number;
        retry_delay_ms?: number;
        goto_node_id?: string;
        skip_default_value?: any;
    };
    checkpoint?: boolean;
    position?: { x: number; y: number };
    label?: string;
}

/**
 * Raw YAML graph structure
 */
interface RawYamlGraph {
    name: string;
    version?: string;
    description?: string;
    parameters?: Array<{
        name: string;
        type: string;
        required?: boolean;
        default?: any;
        description?: string;
    }>;
    variables?: Array<{
        id: string;
        name?: string;
        type: string;
        default?: any;
        description?: string;
    }>;
    nodes: RawYamlNode[];
    connections?: Array<{
        id?: string;
        from: string;
        to: string;
    }>;
    editor?: {
        zoom?: number;
        panX?: number;
        panY?: number;
    };
    coordinator_prompt?: string;
}

/**
 * NodeGraphLoader - Loads and validates node graph definitions from YAML files
 */
export class NodeGraphLoader {
    private basePath: string;
    
    constructor(basePath?: string) {
        this.basePath = basePath || path.join(process.cwd(), '_AiDevLog', 'Workflows');
    }
    
    /**
     * Load a node graph from a YAML file
     * 
     * @param filePath Path to the YAML file (relative to basePath or absolute)
     * @returns Parsed and validated node graph
     */
    async load(filePath: string): Promise<INodeGraph> {
        const fullPath = path.isAbsolute(filePath) 
            ? filePath 
            : path.join(this.basePath, filePath);
        
        log.debug(`Loading node graph from: ${fullPath}`);
        
        // Read file
        let content: string;
        try {
            content = await fs.promises.readFile(fullPath, 'utf-8');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to read node graph file: ${msg}`);
        }
        
        // Parse YAML
        let rawGraph: RawYamlGraph;
        try {
            rawGraph = yaml.parse(content);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse YAML: ${msg}`);
        }
        
        // Convert to internal format
        const graph = this.parseRawGraph(rawGraph);
        
        // Validate
        const validation = this.validate(graph);
        if (!validation.valid) {
            const errorMessages = validation.errors.map(e => e.message).join('\n');
            throw new Error(`Node graph validation failed:\n${errorMessages}`);
        }
        
        // Log warnings
        for (const warning of validation.warnings) {
            log.warn(`Graph ${graph.name}: ${warning.message}`);
        }
        
        return graph;
    }
    
    /**
     * Load a node graph from a YAML string
     */
    loadFromString(yamlContent: string): INodeGraph {
        // Parse YAML
        let rawGraph: RawYamlGraph;
        try {
            rawGraph = yaml.parse(yamlContent);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse YAML: ${msg}`);
        }
        
        // Convert to internal format
        const graph = this.parseRawGraph(rawGraph);
        
        // Validate
        const validation = this.validate(graph);
        if (!validation.valid) {
            const errorMessages = validation.errors.map(e => e.message).join('\n');
            throw new Error(`Node graph validation failed:\n${errorMessages}`);
        }
        
        return graph;
    }
    
    /**
     * Save a node graph to a YAML file
     */
    async save(graph: INodeGraph, filePath: string): Promise<void> {
        const fullPath = path.isAbsolute(filePath) 
            ? filePath 
            : path.join(this.basePath, filePath);
        
        // Convert to YAML-friendly format
        const rawGraph = this.graphToRaw(graph);
        
        // Serialize to YAML
        const yamlContent = yaml.stringify(rawGraph, {
            indent: 2,
            lineWidth: 120
        });
        
        // Ensure directory exists
        const dir = path.dirname(fullPath);
        await fs.promises.mkdir(dir, { recursive: true });
        
        // Write file
        await fs.promises.writeFile(fullPath, yamlContent, 'utf-8');
        
        log.debug(`Saved node graph to: ${fullPath}`);
    }
    
    /**
     * Convert to YAML string
     */
    toYamlString(graph: INodeGraph): string {
        const rawGraph = this.graphToRaw(graph);
        return yaml.stringify(rawGraph, {
            indent: 2,
            lineWidth: 120
        });
    }
    
    /**
     * Validate a node graph
     */
    validate(graph: INodeGraph): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];
        
        // Check required fields
        if (!graph.name) {
            errors.push({ type: 'error', message: 'Graph name is required' });
        }
        
        if (!graph.nodes || graph.nodes.length === 0) {
            errors.push({ type: 'error', message: 'Graph must have at least one node' });
        }
        
        // Validate nodes
        const nodeIds = new Set<string>();
        let hasStart = false;
        let hasEnd = false;
        
        for (const node of graph.nodes) {
            // Check for duplicate IDs
            if (nodeIds.has(node.id)) {
                errors.push({ 
                    type: 'error', 
                    message: `Duplicate node ID: ${node.id}`,
                    nodeId: node.id
                });
            }
            nodeIds.add(node.id);
            
            // Check node type exists
            if (!nodeRegistry.has(node.type)) {
                errors.push({ 
                    type: 'error', 
                    message: `Unknown node type: ${node.type}`,
                    nodeId: node.id
                });
            }
            
            // Track start/end nodes
            if (node.type === 'start') hasStart = true;
            if (node.type === 'end') hasEnd = true;
            
            // Validate node against its definition
            const nodeErrors = nodeRegistry.validateInstance(node);
            for (const err of nodeErrors) {
                errors.push({ type: 'error', message: err, nodeId: node.id });
            }
        }
        
        // Check for start node
        if (!hasStart) {
            errors.push({ type: 'error', message: 'Graph must have a start node' });
        }
        
        // Check for end node
        if (!hasEnd) {
            warnings.push({ type: 'warning', message: 'Graph has no end node' });
        }
        
        // Validate connections
        const connectionIds = new Set<string>();
        
        for (const conn of graph.connections) {
            // Check for duplicate connection IDs
            if (connectionIds.has(conn.id)) {
                errors.push({ 
                    type: 'error', 
                    message: `Duplicate connection ID: ${conn.id}`,
                    connectionId: conn.id
                });
            }
            connectionIds.add(conn.id);
            
            // Check source node exists
            if (!nodeIds.has(conn.fromNodeId)) {
                errors.push({ 
                    type: 'error', 
                    message: `Connection references non-existent source node: ${conn.fromNodeId}`,
                    connectionId: conn.id
                });
            }
            
            // Check target node exists
            if (!nodeIds.has(conn.toNodeId)) {
                errors.push({ 
                    type: 'error', 
                    message: `Connection references non-existent target node: ${conn.toNodeId}`,
                    connectionId: conn.id
                });
            }
            
            // Validate port existence and compatibility
            const sourceNode = graph.nodes.find(n => n.id === conn.fromNodeId);
            const targetNode = graph.nodes.find(n => n.id === conn.toNodeId);
            
            if (sourceNode && targetNode) {
                const sourcePort = sourceNode.outputs.find(p => p.id === conn.fromPortId);
                const targetPort = targetNode.inputs.find(p => p.id === conn.toPortId);
                
                if (!sourcePort) {
                    errors.push({ 
                        type: 'error', 
                        message: `Source port ${conn.fromPortId} not found on node ${conn.fromNodeId}`,
                        connectionId: conn.id
                    });
                }
                
                if (!targetPort) {
                    errors.push({ 
                        type: 'error', 
                        message: `Target port ${conn.toPortId} not found on node ${conn.toNodeId}`,
                        connectionId: conn.id
                    });
                }
                
                // Check port type compatibility
                if (sourcePort && targetPort) {
                    if (!nodeRegistry.arePortsCompatible(sourcePort.dataType, targetPort.dataType)) {
                        warnings.push({ 
                            type: 'warning', 
                            message: `Incompatible port types: ${sourcePort.dataType} -> ${targetPort.dataType}`,
                            connectionId: conn.id
                        });
                    }
                }
            }
        }
        
        // Check for unreachable nodes (nodes with no incoming connections except start)
        for (const node of graph.nodes) {
            if (node.type === 'start') continue;
            
            const hasIncoming = graph.connections.some(c => c.toNodeId === node.id);
            if (!hasIncoming) {
                warnings.push({ 
                    type: 'warning', 
                    message: `Node ${node.id} has no incoming connections and may be unreachable`,
                    nodeId: node.id
                });
            }
        }
        
        // Validate parameters
        if (graph.parameters) {
            const paramNames = new Set<string>();
            for (const param of graph.parameters) {
                if (paramNames.has(param.name)) {
                    errors.push({ 
                        type: 'error', 
                        message: `Duplicate parameter name: ${param.name}`
                    });
                }
                paramNames.add(param.name);
            }
        }
        
        // Validate variables
        if (graph.variables) {
            const varIds = new Set<string>();
            for (const variable of graph.variables) {
                if (varIds.has(variable.id)) {
                    errors.push({ 
                        type: 'error', 
                        message: `Duplicate variable ID: ${variable.id}`
                    });
                }
                varIds.add(variable.id);
            }
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
    
    /**
     * List all workflow files in the base path
     */
    async listWorkflows(): Promise<string[]> {
        try {
            const files = await fs.promises.readdir(this.basePath);
            return files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        } catch {
            return [];
        }
    }
    
    /**
     * Parse raw YAML structure into internal format
     */
    private parseRawGraph(raw: RawYamlGraph): INodeGraph {
        // Parse parameters
        const parameters: IWorkflowParameter[] = (raw.parameters || []).map(p => ({
            name: p.name,
            type: this.parsePortType(p.type),
            required: p.required,
            default: p.default,
            description: p.description
        }));
        
        // Parse variables
        const variables: IWorkflowVariable[] = (raw.variables || []).map(v => ({
            id: v.id,
            name: v.name,
            type: this.parsePortType(v.type),
            default: v.default,
            description: v.description
        }));
        
        // Parse nodes
        const nodes: INodeInstance[] = raw.nodes.map(n => this.parseRawNode(n));
        
        // Parse connections (from node.inputs and explicit connections)
        const connections: INodeConnection[] = [];
        let connIdCounter = 0;
        
        // Extract connections from node inputs
        for (const node of raw.nodes) {
            if (node.inputs) {
                for (const input of node.inputs) {
                    if (input.from) {
                        // Parse "nodeId.portId" format
                        const [fromNodeId, fromPortId] = this.parsePortReference(input.from);
                        connections.push({
                            id: `conn_${connIdCounter++}`,
                            fromNodeId,
                            fromPortId,
                            toNodeId: node.id,
                            toPortId: input.port
                        });
                    }
                }
            }
        }
        
        // Add explicit connections
        if (raw.connections) {
            for (const conn of raw.connections) {
                const [fromNodeId, fromPortId] = this.parsePortReference(conn.from);
                const [toNodeId, toPortId] = this.parsePortReference(conn.to);
                connections.push({
                    id: conn.id || `conn_${connIdCounter++}`,
                    fromNodeId,
                    fromPortId,
                    toNodeId,
                    toPortId
                });
            }
        }
        
        return {
            name: raw.name,
            version: raw.version || '1.0',
            description: raw.description || '',
            parameters,
            variables,
            nodes,
            connections,
            editor: raw.editor,
            coordinatorPrompt: raw.coordinator_prompt
        };
    }
    
    /**
     * Parse a raw YAML node into internal format
     */
    private parseRawNode(raw: RawYamlNode): INodeInstance {
        // Get definition for default ports
        const definition = nodeRegistry.getDefinition(raw.type);
        
        // Build input ports
        const inputs: INodePort[] = definition 
            ? definition.defaultInputs.map(p => ({ ...p, direction: 'input' as const }))
            : [];
        
        // Add any custom input ports from YAML
        if (raw.inputs) {
            for (const input of raw.inputs) {
                const existing = inputs.find(p => p.id === input.port);
                if (!existing && input.type) {
                    inputs.push({
                        id: input.port,
                        name: input.port,
                        direction: 'input',
                        dataType: this.parsePortType(input.type)
                    });
                }
            }
        }
        
        // Build output ports
        const outputs: INodePort[] = definition 
            ? definition.defaultOutputs.map(p => ({ ...p, direction: 'output' as const }))
            : [];
        
        // Add any custom output ports from YAML
        if (raw.outputs) {
            for (const output of raw.outputs) {
                const existing = outputs.find(p => p.id === output.port);
                if (!existing && output.type) {
                    outputs.push({
                        id: output.port,
                        name: output.port,
                        direction: 'output',
                        dataType: this.parsePortType(output.type)
                    });
                }
            }
        }
        
        // Parse error handling config
        let onError: INodeErrorConfig | undefined;
        if (raw.on_error) {
            onError = {
                strategy: raw.on_error.strategy as any,
                maxRetries: raw.on_error.max_retries,
                retryDelayMs: raw.on_error.retry_delay_ms,
                gotoNodeId: raw.on_error.goto_node_id,
                skipDefaultValue: raw.on_error.skip_default_value
            };
        }
        
        return {
            id: raw.id,
            type: raw.type,
            config: raw.config || {},
            inputs,
            outputs,
            timeoutMs: raw.timeout_ms,
            onError,
            checkpoint: raw.checkpoint,
            position: raw.position,
            label: raw.label
        };
    }
    
    /**
     * Convert internal graph to raw YAML format
     */
    private graphToRaw(graph: INodeGraph): RawYamlGraph {
        return {
            name: graph.name,
            version: graph.version,
            description: graph.description,
            parameters: graph.parameters?.map(p => ({
                name: p.name,
                type: p.type,
                required: p.required,
                default: p.default,
                description: p.description
            })),
            variables: graph.variables?.map(v => ({
                id: v.id,
                name: v.name,
                type: v.type,
                default: v.default,
                description: v.description
            })),
            nodes: graph.nodes.map(n => ({
                id: n.id,
                type: n.type,
                config: Object.keys(n.config).length > 0 ? n.config : undefined,
                timeout_ms: n.timeoutMs,
                on_error: n.onError ? {
                    strategy: n.onError.strategy,
                    max_retries: n.onError.maxRetries,
                    retry_delay_ms: n.onError.retryDelayMs,
                    goto_node_id: n.onError.gotoNodeId,
                    skip_default_value: n.onError.skipDefaultValue
                } : undefined,
                checkpoint: n.checkpoint,
                position: n.position,
                label: n.label
            })),
            connections: graph.connections.map(c => ({
                from: `${c.fromNodeId}.${c.fromPortId}`,
                to: `${c.toNodeId}.${c.toPortId}`
            })),
            editor: graph.editor,
            coordinator_prompt: graph.coordinatorPrompt
        };
    }
    
    /**
     * Parse a port reference string (e.g., "nodeId.portId")
     */
    private parsePortReference(ref: string): [string, string] {
        const parts = ref.split('.');
        if (parts.length !== 2) {
            throw new Error(`Invalid port reference: ${ref}. Expected format: nodeId.portId`);
        }
        return [parts[0], parts[1]];
    }
    
    /**
     * Parse a port type string
     */
    private parsePortType(type: string): any {
        const validTypes = ['any', 'string', 'number', 'boolean', 'object', 'array', 'trigger', 'agent'];
        return validTypes.includes(type) ? type : 'any';
    }
}

