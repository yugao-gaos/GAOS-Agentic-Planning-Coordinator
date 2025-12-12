// ============================================================================
// NodeGraphEditorPanel - VS Code webview for visual node graph editing
// ============================================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../../utils/Logger';
import { 
    NodeGraphLoader,
    nodeRegistry,
    registerBuiltinNodes,
    areBuiltinNodesRegistered,
    INodeGraph,
    INodeInstance,
    INodeConnection,
    INodeDefinition
} from '../../services/workflows/scriptable';
import { DefaultRoleConfigs } from '../../types';
import { getWebviewContent } from './webview';

const log = Logger.create('Client', 'NodeGraphEditor');

/**
 * Editor command types from webview
 */
interface EditorCommand {
    type: string;
    payload?: any;
}

/**
 * Undo/Redo action
 */
interface UndoAction {
    type: 'add_node' | 'delete_node' | 'delete_nodes' | 'move_node' | 'move_nodes' | 
          'add_connection' | 'delete_connection' | 'update_config' | 'batch';
    data: any;
    inverseData?: any;
}

/**
 * NodeGraphEditorPanel - Visual editor for node graph workflows
 * 
 * Features:
 * - Node palette with drag-and-drop
 * - Canvas with pan/zoom
 * - Connection drawing between ports
 * - Property panel for node configuration
 * - Save/load YAML files
 * - Undo/redo support
 * - Multi-selection and copy/paste
 * - Grid snapping and alignment
 * - Context menus
 * - Minimap and validation
 */
export class NodeGraphEditorPanel {
    public static currentPanel: NodeGraphEditorPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly workspaceRoot: string;
    private disposables: vscode.Disposable[] = [];
    
    // Graph state
    private graph: INodeGraph | null = null;
    private filePath: string | null = null;
    private isDirty: boolean = false;
    
    // Undo/Redo stacks
    private undoStack: UndoAction[] = [];
    private redoStack: UndoAction[] = [];
    private maxUndoSize: number = 50;
    
    // Graph loader
    private graphLoader: NodeGraphLoader;
    
    // Webview ready state
    private webviewReady: boolean = false;
    private pendingMessages: { type: string; payload?: any }[] = [];
    
    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        workspaceRoot: string
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.workspaceRoot = workspaceRoot;
        this.graphLoader = new NodeGraphLoader(path.join(workspaceRoot, '_AiDevLog', 'Workflows'));
        
        // Ensure built-in nodes are registered
        if (!areBuiltinNodesRegistered()) {
            registerBuiltinNodes();
        }
        
        // Set webview content
        this.panel.webview.html = getWebviewContent();
        
        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );
        
        // Handle panel disposal
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }
    
    /**
     * Create or show the editor panel
     */
    public static createOrShow(
        extensionUri: vscode.Uri,
        workspaceRoot: string,
        filePath?: string
    ): NodeGraphEditorPanel {
        const column = vscode.ViewColumn.One;
        
        // If panel exists, show it
        if (NodeGraphEditorPanel.currentPanel) {
            NodeGraphEditorPanel.currentPanel.panel.reveal(column);
            if (filePath) {
                NodeGraphEditorPanel.currentPanel.loadFile(filePath);
            }
            return NodeGraphEditorPanel.currentPanel;
        }
        
        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'nodeGraphEditor',
            'Node Workflow Editor',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );
        
        NodeGraphEditorPanel.currentPanel = new NodeGraphEditorPanel(
            panel,
            extensionUri,
            workspaceRoot
        );
        
        if (filePath) {
            NodeGraphEditorPanel.currentPanel.loadFile(filePath);
        } else {
            NodeGraphEditorPanel.currentPanel.createNewGraph();
        }
        
        return NodeGraphEditorPanel.currentPanel;
    }
    
    /**
     * Load a graph file
     */
    public async loadFile(filePath: string): Promise<void> {
        try {
            // Use loadRaw to always load the graph, even if validation fails
            this.graph = await this.graphLoader.loadRaw(filePath);
            this.filePath = filePath;
            
            // Ensure required nodes exist (Start, End, Agent Bench)
            this.ensureRequiredNodes();
            
            this.isDirty = false;
            this.undoStack = [];
            this.redoStack = [];
            
            // Update panel title
            this.panel.title = `Node Editor - ${path.basename(filePath)}`;
            
            // Send graph to webview
            this.sendToWebview('loadGraph', { graph: this.graph, filePath });
            
            // Run validation separately and show warnings (not blocking errors)
            const validation = this.graphLoader.validate(this.graph);
            if (!validation.valid) {
                const warningMessages = validation.errors.map(e => e.message).join('\n');
                vscode.window.showWarningMessage(`Graph has validation issues:\n${warningMessages}`);
                log.warn(`Graph validation issues: ${warningMessages}`);
            }
            for (const warning of validation.warnings) {
                log.warn(`Graph ${this.graph.name}: ${warning.message}`);
            }
            
            log.info(`Loaded graph: ${filePath}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load graph: ${errorMsg}`);
        }
    }
    
    /**
     * Create a new empty graph with default nodes (Start, End, Agent Bench)
     */
    public createNewGraph(): void {
        // Create default nodes
        const startNode = nodeRegistry.createInstance('start', 'start_node', {}, { x: 100, y: 200 });
        const endNode = nodeRegistry.createInstance('end', 'end_node', {}, { x: 600, y: 200 });
        const agentBenchNode = nodeRegistry.createInstance('agent_bench', 'agent_bench_node', { seatCount: 3 }, { x: 100, y: 400 });
        
        this.graph = {
            name: 'New Workflow',
            version: '1.0',
            description: '',
            parameters: [],
            variables: [],
            nodes: [startNode, endNode, agentBenchNode],
            connections: [],
            editor: {
                zoom: 1,
                panX: 0,
                panY: 0
            }
        };
        this.filePath = null;
        this.isDirty = false;
        this.undoStack = [];
        this.redoStack = [];
        
        this.panel.title = 'Node Editor - New Workflow';
        this.sendToWebview('loadGraph', { graph: this.graph, filePath: null });
    }
    
    /**
     * Ensure required nodes exist in the graph (Start, End, Agent Bench)
     */
    private ensureRequiredNodes(): void {
        if (!this.graph) return;
        
        // Check for Start node
        const hasStart = this.graph.nodes.some(n => n.type === 'start');
        if (!hasStart) {
            const startNode = nodeRegistry.createInstance('start', 'start_node', {}, { x: 100, y: 200 });
            this.graph.nodes.push(startNode);
        }
        
        // Check for End node
        const hasEnd = this.graph.nodes.some(n => n.type === 'end');
        if (!hasEnd) {
            const endNode = nodeRegistry.createInstance('end', 'end_node', {}, { x: 600, y: 200 });
            this.graph.nodes.push(endNode);
        }
        
        // Check for Agent Bench node
        const hasAgentBench = this.graph.nodes.some(n => n.type === 'agent_bench');
        if (!hasAgentBench) {
            const agentBenchNode = nodeRegistry.createInstance('agent_bench', 'agent_bench_node', { seatCount: 3 }, { x: 100, y: 400 });
            this.graph.nodes.push(agentBenchNode);
        }
    }
    
    /**
     * Handle messages from webview
     */
    private async handleMessage(message: EditorCommand): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.webviewReady = true;
                this.sendNodePalette();
                if (this.graph) {
                    this.sendToWebview('loadGraph', { graph: this.graph, filePath: this.filePath });
                }
                // Send pending messages
                for (const msg of this.pendingMessages) {
                    this.sendToWebview(msg.type, msg.payload);
                }
                this.pendingMessages = [];
                break;
                
            case 'save':
                await this.saveGraph();
                break;
                
            case 'saveAs':
                await this.saveGraphAs();
                break;
                
            case 'addNode':
                this.addNode(message.payload);
                break;
                
            case 'deleteNode':
                this.deleteNode(message.payload.nodeId);
                break;
                
            case 'deleteNodes':
                this.deleteNodes(message.payload.nodeIds);
                break;
                
            case 'moveNode':
                this.moveNode(message.payload.nodeId, message.payload.position);
                break;
                
            case 'moveNodes':
                this.moveNodes(message.payload.positions);
                break;
                
            case 'addConnection':
                this.addConnection(message.payload);
                break;
                
            case 'deleteConnection':
                this.deleteConnection(message.payload.connectionId);
                break;
                
            case 'updateConnection':
                this.updateConnection(message.payload.connectionId, message.payload);
                break;
                
            case 'updateNodeConfig':
                this.updateNodeConfig(message.payload.nodeId, message.payload.config);
                break;
                
            case 'updateNodeLabel':
                this.updateNodeLabel(message.payload.nodeId, message.payload.label);
                break;
                
            case 'updateNodeLocked':
                this.updateNodeLocked(message.payload.nodeId, message.payload.locked);
                break;
                
            case 'updateGraphMeta':
                this.updateGraphMeta(message.payload);
                break;
                
            case 'pasteNodes':
                this.pasteNodes(message.payload.nodes, message.payload.connections);
                break;
                
            case 'undo':
                this.undo();
                break;
                
            case 'redo':
                this.redo();
                break;
                
            case 'requestNodePalette':
                this.sendNodePalette();
                break;
                
            case 'updateEditorState':
                if (this.graph) {
                    this.graph.editor = message.payload;
                }
                break;
        }
    }
    
    /**
     * Send node palette data to webview
     */
    private sendNodePalette(): void {
        const categories = nodeRegistry.getCategorizedDefinitions();
        const palette: Record<string, INodeDefinition[]> = {};
        
        for (const [category, definitions] of categories) {
            palette[category] = definitions;
        }
        
        // Get dynamic options
        const dynamicOptions = this.getDynamicOptions();
        
        this.sendToWebview('nodePalette', palette);
        this.sendToWebview('dynamicOptions', dynamicOptions);
    }
    
    /**
     * Get dynamic options for node config fields
     */
    private getDynamicOptions(): Record<string, { value: string; label: string }[]> {
        const options: Record<string, { value: string; label: string }[]> = {};
        
        // Agent roles from DefaultRoleConfigs
        options['agentRoles'] = Object.entries(DefaultRoleConfigs).map(([id, config]) => ({
            value: id,
            label: config.name
        }));
        
        return options;
    }
    
    /**
     * Add a node to the graph
     */
    private addNode(payload: { type: string; position: { x: number; y: number } }): void {
        if (!this.graph) return;
        
        const nodeId = `node_${Date.now()}`;
        const node = nodeRegistry.createInstance(
            payload.type,
            nodeId,
            {},
            payload.position
        );
        
        // Record for undo
        this.pushUndo({
            type: 'add_node',
            data: { node },
            inverseData: { nodeId }
        });
        
        this.graph.nodes.push(node);
        this.isDirty = true;
        
        this.sendToWebview('nodeAdded', { node });
    }
    
    /**
     * Delete a node from the graph
     */
    private deleteNode(nodeId: string): void {
        if (!this.graph) return;
        
        const nodeIndex = this.graph.nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex < 0) return;
        
        const node = this.graph.nodes[nodeIndex];
        
        // Find connections to delete
        const connectionsToDelete = this.graph.connections.filter(
            c => c.fromNodeId === nodeId || c.toNodeId === nodeId
        );
        
        // Record for undo
        this.pushUndo({
            type: 'delete_node',
            data: { node, connections: connectionsToDelete },
            inverseData: { nodeId }
        });
        
        // Remove node
        this.graph.nodes.splice(nodeIndex, 1);
        
        // Remove connections
        this.graph.connections = this.graph.connections.filter(
            c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId
        );
        
        this.isDirty = true;
        
        this.sendToWebview('nodeDeleted', { 
            nodeId, 
            connectionIds: connectionsToDelete.map(c => c.id) 
        });
    }
    
    /**
     * Delete multiple nodes
     */
    private deleteNodes(nodeIds: string[]): void {
        if (!this.graph || nodeIds.length === 0) return;
        
        const deletedNodes: INodeInstance[] = [];
        const deletedConnections: INodeConnection[] = [];
        
        for (const nodeId of nodeIds) {
            const nodeIndex = this.graph.nodes.findIndex(n => n.id === nodeId);
            if (nodeIndex >= 0) {
                const node = this.graph.nodes[nodeIndex];
                deletedNodes.push(node);
                
                // Find associated connections
                const nodeConnections = this.graph.connections.filter(
                    c => c.fromNodeId === nodeId || c.toNodeId === nodeId
                );
                for (const conn of nodeConnections) {
                    if (!deletedConnections.find(c => c.id === conn.id)) {
                        deletedConnections.push(conn);
                    }
                }
                
                this.graph.nodes.splice(nodeIndex, 1);
            }
        }
        
        // Remove connections
        for (const conn of deletedConnections) {
            const connIndex = this.graph.connections.findIndex(c => c.id === conn.id);
            if (connIndex >= 0) {
                this.graph.connections.splice(connIndex, 1);
            }
        }
        
        // Record for undo
        this.pushUndo({
            type: 'delete_nodes',
            data: { nodes: deletedNodes, connections: deletedConnections },
            inverseData: { nodeIds }
        });
        
        this.isDirty = true;
        
        this.sendToWebview('nodesDeleted', { 
            nodeIds, 
            connectionIds: deletedConnections.map(c => c.id) 
        });
    }
    
    /**
     * Move a node
     */
    private moveNode(nodeId: string, position: { x: number; y: number }): void {
        if (!this.graph) return;
        
        const node = this.graph.nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        const oldPosition = node.position ? { ...node.position } : { x: 0, y: 0 };
        node.position = position;
        this.isDirty = true;
        
        // Record for undo (single node move - typically handled by moveNodes now)
        this.pushUndo({
            type: 'move_node',
            data: { 
                oldPositions: { [nodeId]: oldPosition },
                newPositions: { [nodeId]: position }
            }
        });
    }
    
    /**
     * Move multiple nodes
     */
    private moveNodes(positions: Record<string, { x: number; y: number }>): void {
        if (!this.graph) return;
        
        for (const [nodeId, pos] of Object.entries(positions)) {
            const node = this.graph.nodes.find(n => n.id === nodeId);
            if (node) {
                node.position = pos;
            }
        }
        
        this.isDirty = true;
        // Note: Undo is handled by the webview's UndoManager
    }
    
    /**
     * Add a connection
     */
    private addConnection(payload: {
        fromNodeId: string;
        fromPortId: string;
        toNodeId: string;
        toPortId: string;
    }): void {
        if (!this.graph) return;
        
        const connection: INodeConnection = {
            id: `conn_${Date.now()}`,
            fromNodeId: payload.fromNodeId,
            fromPortId: payload.fromPortId,
            toNodeId: payload.toNodeId,
            toPortId: payload.toPortId
        };
        
        // Check for duplicate
        const exists = this.graph.connections.some(
            c => c.fromNodeId === connection.fromNodeId &&
                 c.fromPortId === connection.fromPortId &&
                 c.toNodeId === connection.toNodeId &&
                 c.toPortId === connection.toPortId
        );
        
        if (exists) return;
        
        // Record for undo
        this.pushUndo({
            type: 'add_connection',
            data: { connection },
            inverseData: { connectionId: connection.id }
        });
        
        this.graph.connections.push(connection);
        this.isDirty = true;
        
        this.sendToWebview('connectionAdded', { connection });
    }
    
    /**
     * Delete a connection
     */
    private deleteConnection(connectionId: string): void {
        if (!this.graph) return;
        
        const connIndex = this.graph.connections.findIndex(c => c.id === connectionId);
        if (connIndex < 0) return;
        
        const connection = this.graph.connections[connIndex];
        
        // Record for undo
        this.pushUndo({
            type: 'delete_connection',
            data: { connection },
            inverseData: { connectionId }
        });
        
        this.graph.connections.splice(connIndex, 1);
        this.isDirty = true;
        
        this.sendToWebview('connectionDeleted', { connectionId });
    }
    
    /**
     * Update connection (e.g., reroute points)
     */
    private updateConnection(connectionId: string, updates: Partial<INodeConnection>): void {
        if (!this.graph) return;
        
        const connection = this.graph.connections.find(c => c.id === connectionId);
        if (!connection) return;
        
        if (updates.reroutes !== undefined) {
            (connection as any).reroutes = updates.reroutes;
        }
        
        this.isDirty = true;
    }
    
    /**
     * Update node configuration
     */
    private updateNodeConfig(nodeId: string, config: Record<string, any>): void {
        if (!this.graph) return;
        
        const node = this.graph.nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        const oldConfig = { ...node.config };
        
        // Record for undo
        this.pushUndo({
            type: 'update_config',
            data: { nodeId, newConfig: { ...node.config, ...config } },
            inverseData: { nodeId, oldConfig }
        });
        
        node.config = { ...node.config, ...config };
        
        // Handle dynamic port updates for branch node
        if (node.type === 'branch' && config.branchCount !== undefined) {
            this.updateBranchPorts(node, config.branchCount);
        }
        
        // Handle dynamic port updates for sync node
        if (node.type === 'sync' && config.inputCount !== undefined) {
            this.updateSyncPorts(node, config.inputCount);
        }
        
        this.isDirty = true;
        
        this.sendToWebview('nodeConfigUpdated', { nodeId, config: node.config });
    }
    
    /**
     * Update branch node ports based on branch count
     */
    private updateBranchPorts(node: INodeInstance, branchCount: number): void {
        // Remove connections to ports that will be deleted
        const maxPortIndex = branchCount - 1;
        this.graph!.connections = this.graph!.connections.filter(c => {
            if (c.fromNodeId === node.id && c.fromPortId.startsWith('out_')) {
                const portIndex = parseInt(c.fromPortId.replace('out_', ''));
                return portIndex <= maxPortIndex;
            }
            return true;
        });
        
        // Preserve inputs (trigger and input)
        node.inputs = [
            {
                id: 'trigger',
                name: 'Trigger',
                direction: 'input',
                dataType: 'trigger',
                description: 'Execution flow trigger'
            },
            {
                id: 'input',
                name: 'Input',
                direction: 'input',
                dataType: 'any',
                description: 'Data to pass to all branches'
            }
        ];
        
        // Generate output ports based on branch count
        node.outputs = [];
        
        for (let i = 0; i < branchCount; i++) {
            node.outputs.push({
                id: `out_${i}`,
                name: `Branch ${i}`,
                direction: 'output',
                dataType: 'trigger',
                description: `Parallel branch ${i}`
            });
        }
        
        // Add the data output port at the end
        node.outputs.push({
            id: 'data',
            name: 'Data',
            direction: 'output',
            dataType: 'any',
            description: 'Input data passed through',
            allowMultiple: true
        });
        
        // Send node updated event to trigger re-render
        this.sendToWebview('nodeUpdated', { node });
    }
    
    /**
     * Update sync node ports based on input count
     */
    private updateSyncPorts(node: INodeInstance, inputCount: number): void {
        // Remove connections to ports that will be deleted
        const maxPortIndex = inputCount - 1;
        this.graph!.connections = this.graph!.connections.filter(c => {
            if (c.toNodeId === node.id && c.toPortId.startsWith('in_')) {
                const portIndex = parseInt(c.toPortId.replace('in_', ''));
                return portIndex <= maxPortIndex;
            }
            return true;
        });
        
        // Generate input ports (trigger type for execution flow)
        node.inputs = [];
        for (let i = 0; i < inputCount; i++) {
            node.inputs.push({
                id: `in_${i}`,
                name: `Branch ${i}`,
                direction: 'input',
                dataType: 'trigger',
                description: `Execution input from branch ${i}`
            });
        }
        
        // Preserve outputs (results and trigger)
        node.outputs = [
            {
                id: 'results',
                name: 'Results',
                direction: 'output',
                dataType: 'array',
                description: 'Array of results from all branches'
            },
            {
                id: 'trigger',
                name: 'Trigger',
                direction: 'output',
                dataType: 'trigger',
                description: 'Triggered when all branches complete'
            }
        ];
        
        // Send node updated event to trigger re-render
        this.sendToWebview('nodeUpdated', { node });
    }
    
    /**
     * Update node label
     */
    private updateNodeLabel(nodeId: string, label: string): void {
        if (!this.graph) return;
        
        const node = this.graph.nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        node.label = label || undefined;
        this.isDirty = true;
    }
    
    /**
     * Update node locked state
     */
    private updateNodeLocked(nodeId: string, locked: boolean): void {
        if (!this.graph) return;
        
        const node = this.graph.nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        node.locked = locked || undefined;
        this.isDirty = true;
    }
    
    /**
     * Update graph metadata
     */
    private updateGraphMeta(meta: Partial<INodeGraph>): void {
        if (!this.graph) return;
        
        if (meta.name !== undefined) this.graph.name = meta.name;
        if (meta.description !== undefined) this.graph.description = meta.description;
        if (meta.version !== undefined) this.graph.version = meta.version;
        if (meta.parameters !== undefined) this.graph.parameters = meta.parameters;
        if (meta.variables !== undefined) this.graph.variables = meta.variables;
        
        this.isDirty = true;
    }
    
    /**
     * Paste nodes from clipboard
     */
    private pasteNodes(nodes: INodeInstance[], connections: INodeConnection[]): void {
        if (!this.graph) return;
        
        // Add nodes
        for (const node of nodes) {
            this.graph.nodes.push(node);
        }
        
        // Add connections
        for (const conn of connections) {
            this.graph.connections.push(conn);
        }
        
        // Record for undo
        this.pushUndo({
            type: 'delete_nodes',  // Inverse of paste is delete
            data: { nodes, connections },
            inverseData: { nodeIds: nodes.map(n => n.id) }
        });
        
        this.isDirty = true;
        
        this.sendToWebview('nodesCreated', { nodes, connections });
    }
    
    /**
     * Push action to undo stack
     */
    private pushUndo(action: UndoAction): void {
        this.undoStack.push(action);
        if (this.undoStack.length > this.maxUndoSize) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        
        this.sendToWebview('undoRedoState', {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0
        });
    }
    
    /**
     * Undo last action
     */
    private undo(): void {
        if (this.undoStack.length === 0) return;
        
        const action = this.undoStack.pop()!;
        this.redoStack.push(action);
        
        this.applyUndo(action);
        
        this.sendToWebview('undoRedoState', {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0
        });
    }
    
    /**
     * Redo last undone action
     */
    private redo(): void {
        if (this.redoStack.length === 0) return;
        
        const action = this.redoStack.pop()!;
        this.undoStack.push(action);
        
        this.applyRedo(action);
        
        this.sendToWebview('undoRedoState', {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0
        });
    }
    
    /**
     * Apply undo for a single action
     */
    private applyUndo(action: UndoAction): void {
        if (!this.graph) return;
        
        switch (action.type) {
            case 'add_node':
                const addIdx = this.graph.nodes.findIndex(n => n.id === action.data.node.id);
                if (addIdx >= 0) {
                    this.graph.nodes.splice(addIdx, 1);
                    this.sendToWebview('nodeDeleted', { nodeId: action.data.node.id, connectionIds: [] });
                }
                break;
                
            case 'delete_node':
                this.graph.nodes.push(action.data.node);
                action.data.connections?.forEach((c: INodeConnection) => this.graph!.connections.push(c));
                this.sendToWebview('nodeAdded', { node: action.data.node });
                action.data.connections?.forEach((c: INodeConnection) => 
                    this.sendToWebview('connectionAdded', { connection: c })
                );
                break;
                
            case 'delete_nodes':
                for (const node of action.data.nodes) {
                    this.graph.nodes.push(node);
                }
                for (const conn of action.data.connections || []) {
                    this.graph.connections.push(conn);
                }
                this.sendToWebview('nodesCreated', { 
                    nodes: action.data.nodes, 
                    connections: action.data.connections || [] 
                });
                break;
                
            case 'move_node':
            case 'move_nodes':
                if (action.data.oldPositions) {
                    for (const [nodeId, pos] of Object.entries(action.data.oldPositions)) {
                        const node = this.graph.nodes.find(n => n.id === nodeId);
                        if (node) {
                            node.position = pos as { x: number; y: number };
                        }
                    }
                    this.sendToWebview('nodesMoved', { positions: action.data.oldPositions });
                }
                break;
                
            case 'add_connection':
                const connIdx = this.graph.connections.findIndex(c => c.id === action.data.connection.id);
                if (connIdx >= 0) {
                    this.graph.connections.splice(connIdx, 1);
                    this.sendToWebview('connectionDeleted', { connectionId: action.data.connection.id });
                }
                break;
                
            case 'delete_connection':
                this.graph.connections.push(action.data.connection);
                this.sendToWebview('connectionAdded', { connection: action.data.connection });
                break;
                
            case 'update_config':
                const cfgNode = this.graph.nodes.find(n => n.id === action.inverseData?.nodeId);
                if (cfgNode && action.inverseData?.oldConfig) {
                    cfgNode.config = action.inverseData.oldConfig;
                    this.sendToWebview('nodeConfigUpdated', { 
                        nodeId: action.inverseData.nodeId, 
                        config: action.inverseData.oldConfig 
                    });
                }
                break;
        }
        
        this.isDirty = true;
    }
    
    /**
     * Apply redo for a single action
     */
    private applyRedo(action: UndoAction): void {
        if (!this.graph) return;
        
        switch (action.type) {
            case 'add_node':
                this.graph.nodes.push(action.data.node);
                this.sendToWebview('nodeAdded', { node: action.data.node });
                break;
                
            case 'delete_node':
                const delIdx = this.graph.nodes.findIndex(n => n.id === action.data.node.id);
                if (delIdx >= 0) {
                    this.graph.nodes.splice(delIdx, 1);
                }
                action.data.connections?.forEach((c: INodeConnection) => {
                    const cIdx = this.graph!.connections.findIndex(conn => conn.id === c.id);
                    if (cIdx >= 0) this.graph!.connections.splice(cIdx, 1);
                });
                this.sendToWebview('nodeDeleted', { 
                    nodeId: action.data.node.id, 
                    connectionIds: action.data.connections?.map((c: INodeConnection) => c.id) || []
                });
                break;
                
            case 'delete_nodes':
                for (const node of action.data.nodes) {
                    const idx = this.graph.nodes.findIndex(n => n.id === node.id);
                    if (idx >= 0) this.graph.nodes.splice(idx, 1);
                }
                for (const conn of action.data.connections || []) {
                    const cIdx = this.graph.connections.findIndex(c => c.id === conn.id);
                    if (cIdx >= 0) this.graph.connections.splice(cIdx, 1);
                }
                this.sendToWebview('nodesDeleted', { 
                    nodeIds: action.data.nodes.map((n: INodeInstance) => n.id),
                    connectionIds: (action.data.connections || []).map((c: INodeConnection) => c.id)
                });
                break;
                
            case 'move_node':
            case 'move_nodes':
                if (action.data.newPositions) {
                    for (const [nodeId, pos] of Object.entries(action.data.newPositions)) {
                        const node = this.graph.nodes.find(n => n.id === nodeId);
                        if (node) {
                            node.position = pos as { x: number; y: number };
                        }
                    }
                    this.sendToWebview('nodesMoved', { positions: action.data.newPositions });
                }
                break;
                
            case 'add_connection':
                this.graph.connections.push(action.data.connection);
                this.sendToWebview('connectionAdded', { connection: action.data.connection });
                break;
                
            case 'delete_connection':
                const connIdx = this.graph.connections.findIndex(c => c.id === action.data.connection.id);
                if (connIdx >= 0) {
                    this.graph.connections.splice(connIdx, 1);
                    this.sendToWebview('connectionDeleted', { connectionId: action.data.connection.id });
                }
                break;
                
            case 'update_config':
                const cfgNode = this.graph.nodes.find(n => n.id === action.data.nodeId);
                if (cfgNode && action.data.newConfig) {
                    cfgNode.config = action.data.newConfig;
                    this.sendToWebview('nodeConfigUpdated', { 
                        nodeId: action.data.nodeId, 
                        config: action.data.newConfig 
                    });
                }
                break;
        }
        
        this.isDirty = true;
    }
    
    /**
     * Save the graph to current file
     */
    private async saveGraph(): Promise<void> {
        if (!this.graph) return;
        
        if (!this.filePath) {
            await this.saveGraphAs();
            return;
        }
        
        try {
            await this.graphLoader.save(this.graph, this.filePath);
            this.isDirty = false;
            vscode.window.showInformationMessage(`Saved: ${path.basename(this.filePath)}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to save: ${errorMsg}`);
        }
    }
    
    /**
     * Save the graph to a new file
     */
    private async saveGraphAs(): Promise<void> {
        if (!this.graph) return;
        
        const workflowsDir = path.join(this.workspaceRoot, '_AiDevLog', 'Workflows');
        
        // Ensure directory exists
        if (!fs.existsSync(workflowsDir)) {
            fs.mkdirSync(workflowsDir, { recursive: true });
        }
        
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(workflowsDir, `${this.graph.name}.yaml`)),
            filters: {
                'YAML files': ['yaml', 'yml']
            }
        });
        
        if (uri) {
            this.filePath = uri.fsPath;
            await this.saveGraph();
            this.panel.title = `Node Editor - ${path.basename(this.filePath)}`;
        }
    }
    
    /**
     * Send message to webview
     */
    private sendToWebview(type: string, payload?: any): void {
        if (!this.webviewReady) {
            this.pendingMessages.push({ type, payload });
            return;
        }
        this.panel.webview.postMessage({ type, payload });
    }
    
    /**
     * Dispose resources
     */
    public dispose(): void {
        NodeGraphEditorPanel.currentPanel = undefined;
        
        this.panel.dispose();
        
        while (this.disposables.length) {
            const x = this.disposables.pop();
            if (x) x.dispose();
        }
    }
}

