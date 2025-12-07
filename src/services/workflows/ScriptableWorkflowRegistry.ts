// ============================================================================
// ScriptableWorkflowRegistry - Dynamic workflow type registration from YAML
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { WorkflowType, WorkflowConfig } from '../../types/workflow';
import { WorkflowRegistry } from './WorkflowRegistry';
import { WorkflowServices, WorkflowMetadata } from './IWorkflow';
import { ScriptableNodeWorkflow } from './scriptable/ScriptableNodeWorkflow';
import { NodeGraphLoader } from './scriptable/NodeGraphLoader';
import { INodeGraph } from './scriptable/NodeTypes';
import { registerBuiltinNodes, areBuiltinNodesRegistered } from './scriptable/nodes';
import { Logger } from '../../utils/Logger';

const log = Logger.create('Daemon', 'ScriptableWorkflowRegistry');

/**
 * Registered custom workflow info
 */
interface CustomWorkflowInfo {
    /** Full path to YAML file */
    filePath: string;
    
    /** Workflow type ID (e.g., 'custom:my_workflow') */
    workflowType: string;
    
    /** Parsed graph (cached) - may be partial if validation failed */
    graph: INodeGraph;
    
    /** Last modified time */
    lastModified: number;
    
    /** Whether the workflow passed validation */
    isValid: boolean;
    
    /** Validation error message if invalid */
    validationError?: string;
}

/**
 * ScriptableWorkflowRegistry - Manages dynamic workflow types from YAML files
 * 
 * Features:
 * - Scans _AiDevLog/Workflows/ for .yaml files
 * - Registers each as `custom:{name}` WorkflowType
 * - Watches for file changes and hot-reloads
 * - Auto-generates coordinator prompts from graph metadata
 */
export class ScriptableWorkflowRegistry {
    private basePath: string;
    private workflowRegistry: WorkflowRegistry;
    private graphLoader: NodeGraphLoader;
    private customWorkflows: Map<string, CustomWorkflowInfo> = new Map();
    private watcher?: chokidar.FSWatcher;
    private isWatching: boolean = false;
    
    constructor(workflowRegistry: WorkflowRegistry, basePath?: string) {
        this.workflowRegistry = workflowRegistry;
        this.basePath = basePath || path.join(process.cwd(), '_AiDevLog', 'Workflows');
        this.graphLoader = new NodeGraphLoader(this.basePath);
        
        // Ensure built-in nodes are registered
        if (!areBuiltinNodesRegistered()) {
            registerBuiltinNodes();
        }
    }
    
    /**
     * Initialize the registry by scanning for workflow files
     */
    async initialize(): Promise<void> {
        log.info(`Initializing ScriptableWorkflowRegistry at: ${this.basePath}`);
        
        // Ensure directory exists
        if (!fs.existsSync(this.basePath)) {
            fs.mkdirSync(this.basePath, { recursive: true });
            log.info(`Created workflows directory: ${this.basePath}`);
        }
        
        // Scan for existing workflows
        await this.scanWorkflows();
        
        log.info(`Registered ${this.customWorkflows.size} custom workflows`);
    }
    
    /**
     * Start watching for file changes
     */
    startWatching(): void {
        if (this.isWatching) return;
        
        log.info('Starting workflow file watcher...');
        
        this.watcher = chokidar.watch(this.basePath, {
            ignored: /(^|[\/\\])\../, // Ignore dot files
            persistent: true,
            ignoreInitial: true
        });
        
        this.watcher
            .on('add', (filePath) => this.handleFileChange(filePath, 'add'))
            .on('change', (filePath) => this.handleFileChange(filePath, 'change'))
            .on('unlink', (filePath) => this.handleFileChange(filePath, 'remove'));
        
        this.isWatching = true;
    }
    
    /**
     * Stop watching for file changes
     */
    stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
        }
        this.isWatching = false;
    }
    
    /**
     * Scan for workflow YAML files and register them
     */
    private async scanWorkflows(): Promise<void> {
        const files = await this.graphLoader.listWorkflows();
        
        for (const file of files) {
            try {
                await this.registerWorkflowFile(path.join(this.basePath, file));
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                log.warn(`Failed to register workflow ${file}: ${errorMsg}`);
            }
        }
    }
    
    /**
     * Register a workflow from a YAML file
     */
    private async registerWorkflowFile(filePath: string): Promise<void> {
        // Only process .yaml/.yml files
        if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
            return;
        }
        
        log.debug(`Loading workflow from: ${filePath}`);
        
        // Get file stats
        const stats = fs.statSync(filePath);
        
        let graph: INodeGraph;
        let isValid = true;
        let validationError: string | undefined;
        
        try {
            // Load and parse the graph (includes validation)
            graph = await this.graphLoader.load(filePath);
        } catch (error) {
            // Validation failed - try to load without validation for display purposes
            validationError = error instanceof Error ? error.message : String(error);
            isValid = false;
            log.warn(`Workflow validation failed for ${filePath}: ${validationError}`);
            
            // Try to load raw YAML for display
            try {
                graph = await this.graphLoader.loadRaw(filePath);
            } catch {
                // Can't even parse YAML - create minimal placeholder
                const fileName = path.basename(filePath, path.extname(filePath));
                graph = {
                    name: fileName,
                    version: '1.0',
                    description: 'Failed to parse workflow file',
                    parameters: [],
                    variables: [],
                    nodes: [],
                    connections: []
                };
            }
        }
        
        // Generate workflow type ID
        const workflowType = this.getWorkflowTypeId(graph.name);
        
        // Unregister if already exists
        if (this.customWorkflows.has(workflowType)) {
            this.workflowRegistry.unregister(workflowType as WorkflowType);
        }
        
        // Store info (even if invalid, so it shows in the list)
        const info: CustomWorkflowInfo = {
            filePath,
            workflowType,
            graph,
            lastModified: stats.mtimeMs,
            isValid,
            validationError
        };
        
        this.customWorkflows.set(workflowType, info);
        
        // Only register with workflow registry if valid (so it can be executed)
        if (isValid) {
            // Create factory function
            const factory = (config: WorkflowConfig, services: WorkflowServices) => {
                return new ScriptableNodeWorkflow(
                    {
                        ...config,
                        input: {
                            ...config.input,
                            graphPath: filePath
                        }
                    },
                    services
                );
            };
            
            // Build metadata
            const metadata: Partial<WorkflowMetadata> = {
                name: graph.name,
                requiresUnity: this.checkRequiresUnity(graph),
                requiresCompleteDependencies: true,
                coordinatorPrompt: this.generateCoordinatorPrompt(graph)
            };
            
            // Register with workflow registry
            this.workflowRegistry.register(
                workflowType as WorkflowType,
                factory,
                metadata
            );
            
            log.info(`Registered custom workflow: ${workflowType} (${graph.nodes.length} nodes)`);
        } else {
            log.info(`Stored invalid workflow for editing: ${workflowType}`);
        }
    }
    
    /**
     * Handle file system changes
     */
    private async handleFileChange(
        filePath: string, 
        changeType: 'add' | 'change' | 'remove'
    ): Promise<void> {
        // Only process .yaml/.yml files
        if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
            return;
        }
        
        log.debug(`Workflow file ${changeType}: ${filePath}`);
        
        if (changeType === 'remove') {
            // Find and unregister the workflow
            for (const [workflowType, info] of this.customWorkflows) {
                if (info.filePath === filePath) {
                    this.workflowRegistry.unregister(workflowType as WorkflowType);
                    this.customWorkflows.delete(workflowType);
                    log.info(`Unregistered custom workflow: ${workflowType}`);
                    break;
                }
            }
        } else {
            // Add or update
            try {
                await this.registerWorkflowFile(filePath);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                log.warn(`Failed to ${changeType} workflow ${filePath}: ${errorMsg}`);
            }
        }
    }
    
    /**
     * Generate workflow type ID from graph name
     */
    private getWorkflowTypeId(name: string): string {
        // Convert to snake_case and prefix with 'custom:'
        const safeName = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        
        return `custom:${safeName}`;
    }
    
    /**
     * Check if a graph requires Unity features
     */
    private checkRequiresUnity(graph: INodeGraph): boolean {
        // Check if any node uses Unity-specific features
        for (const node of graph.nodes) {
            if (node.type === 'event') {
                const eventType = node.config?.eventType;
                if (eventType === 'unity_compile' || eventType === 'unity_test') {
                    return true;
                }
            }
        }
        return false;
    }
    
    /**
     * Generate coordinator prompt from graph metadata
     */
    private generateCoordinatorPrompt(graph: INodeGraph): string {
        // Use custom prompt if provided
        if (graph.coordinatorPrompt) {
            return graph.coordinatorPrompt;
        }
        
        // Auto-generate prompt
        const workflowType = this.getWorkflowTypeId(graph.name);
        const description = graph.description || `Custom workflow: ${graph.name}`;
        
        // Build parameter hint
        let paramHint = '';
        if (graph.parameters && graph.parameters.length > 0) {
            const paramList = graph.parameters
                .map(p => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
                .join(', ');
            paramHint = `\n   Parameters: ${paramList}`;
        }
        
        return `- '${workflowType}' - ${description}${paramHint}`;
    }
    
    /**
     * Get all registered custom workflow types
     */
    getCustomWorkflowTypes(): string[] {
        return Array.from(this.customWorkflows.keys());
    }
    
    /**
     * Get info about a custom workflow
     */
    getWorkflowInfo(workflowType: string): CustomWorkflowInfo | undefined {
        return this.customWorkflows.get(workflowType);
    }
    
    /**
     * Get all custom workflow info
     */
    getAllWorkflowInfo(): CustomWorkflowInfo[] {
        return Array.from(this.customWorkflows.values());
    }
    
    /**
     * Reload a specific workflow
     */
    async reloadWorkflow(workflowType: string): Promise<void> {
        const info = this.customWorkflows.get(workflowType);
        if (info) {
            await this.registerWorkflowFile(info.filePath);
        }
    }
    
    /**
     * Reload all workflows
     */
    async reloadAll(): Promise<void> {
        this.customWorkflows.clear();
        await this.scanWorkflows();
    }
    
    /**
     * Check if a workflow file already exists for the given name
     */
    workflowFileExists(name: string): string | null {
        const safeName = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        
        const filePath = path.join(this.basePath, `${safeName}.yaml`);
        return fs.existsSync(filePath) ? filePath : null;
    }
    
    /**
     * Create a new workflow YAML file from template
     */
    async createWorkflowTemplate(name: string): Promise<string> {
        const safeName = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        
        const filePath = path.join(this.basePath, `${safeName}.yaml`);
        
        const template = `name: ${name}
version: 1.0
description: Custom workflow - ${name}

parameters:
  - name: input_data
    type: object
    required: false
    description: Input data for the workflow

variables:
  - id: result
    type: any
    default: null

nodes:
  - id: start
    type: start
    position:
      x: 100
      y: 200

  - id: end
    type: end
    config:
      outputKey: result
      success: true
    position:
      x: 400
      y: 200

connections:
  - from: start.trigger
    to: end.trigger
`;
        
        await fs.promises.writeFile(filePath, template, 'utf-8');
        
        log.info(`Created workflow template: ${filePath}`);
        
        // Explicitly register the workflow instead of waiting for file watcher
        // This ensures the workflow is immediately available
        try {
            await this.registerWorkflowFile(filePath);
            log.info(`Workflow registered: ${filePath}`);
        } catch (regError) {
            log.warn(`Failed to register new workflow (will retry via watcher): ${regError}`);
        }
        
        return filePath;
    }
    
    /**
     * Cleanup
     */
    dispose(): void {
        this.stopWatching();
        
        // Unregister all custom workflows
        for (const workflowType of this.customWorkflows.keys()) {
            this.workflowRegistry.unregister(workflowType as WorkflowType);
        }
        
        this.customWorkflows.clear();
    }
}

