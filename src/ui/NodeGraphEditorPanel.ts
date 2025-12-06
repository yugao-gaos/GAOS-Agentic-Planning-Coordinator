// ============================================================================
// NodeGraphEditorPanel - VS Code webview for visual node graph editing
// ============================================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { 
    NodeGraphLoader,
    nodeRegistry,
    registerBuiltinNodes,
    areBuiltinNodesRegistered,
    INodeGraph,
    INodeInstance,
    INodeConnection,
    INodeDefinition,
    NodeCategory
} from '../services/workflows/scriptable';

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
    type: 'add_node' | 'delete_node' | 'move_node' | 'add_connection' | 'delete_connection' | 'update_config' | 'batch';
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
        
        // Set initial content
        this.updateWebviewContent();
        
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
            this.graph = await this.graphLoader.load(filePath);
            this.filePath = filePath;
            this.isDirty = false;
            this.undoStack = [];
            this.redoStack = [];
            
            // Update panel title
            this.panel.title = `Node Editor - ${path.basename(filePath)}`;
            
            // Send graph to webview
            this.sendToWebview('loadGraph', { graph: this.graph, filePath });
            
            log.info(`Loaded graph: ${filePath}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load graph: ${errorMsg}`);
        }
    }
    
    /**
     * Create a new empty graph
     */
    public createNewGraph(): void {
        this.graph = {
            name: 'New Workflow',
            version: '1.0',
            description: '',
            parameters: [],
            variables: [],
            nodes: [],
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
     * Handle messages from webview
     */
    private async handleMessage(message: EditorCommand): Promise<void> {
        switch (message.type) {
            case 'ready':
                // Webview is ready, send initial data
                this.sendNodePalette();
                if (this.graph) {
                    this.sendToWebview('loadGraph', { graph: this.graph, filePath: this.filePath });
                }
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
                
            case 'moveNode':
                this.moveNode(message.payload.nodeId, message.payload.position);
                break;
                
            case 'addConnection':
                this.addConnection(message.payload);
                break;
                
            case 'deleteConnection':
                this.deleteConnection(message.payload.connectionId);
                break;
                
            case 'updateNodeConfig':
                this.updateNodeConfig(message.payload.nodeId, message.payload.config);
                break;
                
            case 'updateGraphMeta':
                this.updateGraphMeta(message.payload);
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
        
        this.sendToWebview('nodePalette', palette);
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
        
        this.sendToWebview('nodeDeleted', { nodeId, connectionIds: connectionsToDelete.map(c => c.id) });
    }
    
    /**
     * Move a node
     */
    private moveNode(nodeId: string, position: { x: number; y: number }): void {
        if (!this.graph) return;
        
        const node = this.graph.nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        const oldPosition = node.position ? { ...node.position } : { x: 0, y: 0 };
        
        // Record for undo
        this.pushUndo({
            type: 'move_node',
            data: { nodeId, position },
            inverseData: { nodeId, position: oldPosition }
        });
        
        node.position = position;
        this.isDirty = true;
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
            data: { nodeId, config },
            inverseData: { nodeId, config: oldConfig }
        });
        
        node.config = { ...node.config, ...config };
        this.isDirty = true;
        
        this.sendToWebview('nodeConfigUpdated', { nodeId, config: node.config });
    }
    
    /**
     * Update graph metadata
     */
    private updateGraphMeta(meta: { name?: string; description?: string; version?: string }): void {
        if (!this.graph) return;
        
        if (meta.name !== undefined) this.graph.name = meta.name;
        if (meta.description !== undefined) this.graph.description = meta.description;
        if (meta.version !== undefined) this.graph.version = meta.version;
        
        this.isDirty = true;
    }
    
    /**
     * Push action to undo stack
     */
    private pushUndo(action: UndoAction): void {
        this.undoStack.push(action);
        if (this.undoStack.length > this.maxUndoSize) {
            this.undoStack.shift();
        }
        this.redoStack = []; // Clear redo stack on new action
        
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
        
        // Apply inverse action
        switch (action.type) {
            case 'add_node':
                // Undo add = delete
                this.graph?.nodes.splice(
                    this.graph.nodes.findIndex(n => n.id === action.data.node.id), 1
                );
                this.sendToWebview('nodeDeleted', { nodeId: action.data.node.id, connectionIds: [] });
                break;
                
            case 'delete_node':
                // Undo delete = add back
                this.graph?.nodes.push(action.data.node);
                action.data.connections.forEach((c: INodeConnection) => this.graph?.connections.push(c));
                this.sendToWebview('nodeAdded', { node: action.data.node });
                action.data.connections.forEach((c: INodeConnection) => 
                    this.sendToWebview('connectionAdded', { connection: c })
                );
                break;
                
            case 'move_node':
                const moveNode = this.graph?.nodes.find(n => n.id === action.inverseData.nodeId);
                if (moveNode) {
                    moveNode.position = action.inverseData.position;
                    this.sendToWebview('nodeMoved', { nodeId: action.inverseData.nodeId, position: action.inverseData.position });
                }
                break;
                
            case 'add_connection':
                this.graph?.connections.splice(
                    this.graph.connections.findIndex(c => c.id === action.data.connection.id), 1
                );
                this.sendToWebview('connectionDeleted', { connectionId: action.data.connection.id });
                break;
                
            case 'delete_connection':
                this.graph?.connections.push(action.data.connection);
                this.sendToWebview('connectionAdded', { connection: action.data.connection });
                break;
                
            case 'update_config':
                const configNode = this.graph?.nodes.find(n => n.id === action.inverseData.nodeId);
                if (configNode) {
                    configNode.config = action.inverseData.config;
                    this.sendToWebview('nodeConfigUpdated', { nodeId: action.inverseData.nodeId, config: action.inverseData.config });
                }
                break;
        }
        
        this.isDirty = true;
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
        
        // Apply original action
        switch (action.type) {
            case 'add_node':
                this.graph?.nodes.push(action.data.node);
                this.sendToWebview('nodeAdded', { node: action.data.node });
                break;
                
            case 'delete_node':
                this.graph?.nodes.splice(
                    this.graph.nodes.findIndex(n => n.id === action.data.node.id), 1
                );
                action.data.connections.forEach((c: INodeConnection) => {
                    const idx = this.graph?.connections.findIndex(conn => conn.id === c.id);
                    if (idx !== undefined && idx >= 0) this.graph?.connections.splice(idx, 1);
                });
                this.sendToWebview('nodeDeleted', { 
                    nodeId: action.data.node.id, 
                    connectionIds: action.data.connections.map((c: INodeConnection) => c.id) 
                });
                break;
                
            case 'move_node':
                const moveNode = this.graph?.nodes.find(n => n.id === action.data.nodeId);
                if (moveNode) {
                    moveNode.position = action.data.position;
                    this.sendToWebview('nodeMoved', { nodeId: action.data.nodeId, position: action.data.position });
                }
                break;
                
            case 'add_connection':
                this.graph?.connections.push(action.data.connection);
                this.sendToWebview('connectionAdded', { connection: action.data.connection });
                break;
                
            case 'delete_connection':
                this.graph?.connections.splice(
                    this.graph.connections.findIndex(c => c.id === action.data.connection.id), 1
                );
                this.sendToWebview('connectionDeleted', { connectionId: action.data.connection.id });
                break;
                
            case 'update_config':
                const configNode = this.graph?.nodes.find(n => n.id === action.data.nodeId);
                if (configNode) {
                    configNode.config = action.data.config;
                    this.sendToWebview('nodeConfigUpdated', { nodeId: action.data.nodeId, config: action.data.config });
                }
                break;
        }
        
        this.isDirty = true;
        this.sendToWebview('undoRedoState', {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0
        });
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
        this.panel.webview.postMessage({ type, payload });
    }
    
    /**
     * Update webview HTML content
     */
    private updateWebviewContent(): void {
        this.panel.webview.html = this.getWebviewContent();
    }
    
    /**
     * Get webview HTML
     */
    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Node Workflow Editor</title>
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <div class="editor-container">
        <!-- Toolbar -->
        <div class="toolbar">
            <div class="toolbar-left">
                <button id="btn-save" title="Save (Ctrl+S)">💾 Save</button>
                <button id="btn-new" title="New Workflow">📄 New</button>
                <span class="separator"></span>
                <button id="btn-undo" title="Undo (Ctrl+Z)" disabled>↩ Undo</button>
                <button id="btn-redo" title="Redo (Ctrl+Y)" disabled>↪ Redo</button>
            </div>
            <div class="toolbar-center">
                <input type="text" id="graph-name" placeholder="Workflow Name" value="New Workflow">
            </div>
            <div class="toolbar-right">
                <span id="zoom-level">100%</span>
                <button id="btn-zoom-fit" title="Fit to View">⊡</button>
            </div>
        </div>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Node Palette -->
            <div class="palette">
                <div class="palette-header">Nodes</div>
                <div id="node-palette" class="palette-content">
                    <!-- Categories and nodes will be populated -->
                </div>
            </div>
            
            <!-- Canvas -->
            <div class="canvas-container" id="canvas-container">
                <svg id="connections-svg" class="connections-layer"></svg>
                <div id="nodes-container" class="nodes-layer"></div>
            </div>
            
            <!-- Properties Panel -->
            <div class="properties">
                <div class="properties-header">Properties</div>
                <div id="properties-content" class="properties-content">
                    <p class="placeholder">Select a node to edit its properties</p>
                </div>
            </div>
        </div>
        
        <!-- Status Bar -->
        <div class="status-bar">
            <span id="status-text">Ready</span>
            <span id="node-count">Nodes: 0</span>
            <span id="connection-count">Connections: 0</span>
        </div>
    </div>
    
    <script>
        ${this.getScript()}
    </script>
</body>
</html>`;
    }
    
    /**
     * Get CSS styles
     */
    private getStyles(): string {
        return `
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            overflow: hidden;
        }
        
        .editor-container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        
        /* Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .toolbar button {
            padding: 4px 12px;
            margin-right: 4px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .toolbar button:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .toolbar .separator {
            width: 1px;
            height: 20px;
            background: var(--vscode-panel-border);
            margin: 0 8px;
        }
        
        .toolbar input {
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            width: 200px;
            text-align: center;
        }
        
        /* Main Content */
        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        
        /* Palette */
        .palette {
            width: 200px;
            background: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
        }
        
        .palette-header, .properties-header {
            padding: 8px 12px;
            font-weight: 600;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .palette-content {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }
        
        .palette-category {
            margin-bottom: 12px;
        }
        
        .category-header {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            padding: 4px 0;
        }
        
        .palette-node {
            padding: 6px 10px;
            margin-bottom: 4px;
            background: var(--vscode-badge-background);
            border-radius: 4px;
            cursor: grab;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .palette-node:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .palette-node.dragging {
            opacity: 0.5;
        }
        
        /* Canvas */
        .canvas-container {
            flex: 1;
            position: relative;
            overflow: hidden;
            background: var(--vscode-editor-background);
            background-image: 
                linear-gradient(rgba(128,128,128,0.1) 1px, transparent 1px),
                linear-gradient(90deg, rgba(128,128,128,0.1) 1px, transparent 1px);
            background-size: 20px 20px;
        }
        
        .connections-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }
        
        .nodes-layer {
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: 0 0;
        }
        
        /* Node */
        .node {
            position: absolute;
            min-width: 150px;
            background: var(--vscode-editor-background);
            border: 2px solid var(--vscode-panel-border);
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            cursor: move;
        }
        
        .node.selected {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 2px var(--vscode-focusBorder);
        }
        
        .node-header {
            padding: 8px 12px;
            background: var(--vscode-badge-background);
            border-radius: 6px 6px 0 0;
            font-weight: 600;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .node-body {
            padding: 8px 0;
        }
        
        .node-port {
            display: flex;
            align-items: center;
            padding: 4px 12px;
            font-size: 11px;
        }
        
        .node-port.input {
            justify-content: flex-start;
        }
        
        .node-port.output {
            justify-content: flex-end;
        }
        
        .port-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--vscode-badge-background);
            border: 2px solid var(--vscode-foreground);
            cursor: crosshair;
        }
        
        .port-dot:hover {
            background: var(--vscode-focusBorder);
        }
        
        .port-dot.input {
            margin-right: 6px;
        }
        
        .port-dot.output {
            margin-left: 6px;
        }
        
        /* Connection */
        .connection {
            fill: none;
            stroke: var(--vscode-foreground);
            stroke-width: 2;
            pointer-events: stroke;
        }
        
        .connection:hover {
            stroke: var(--vscode-focusBorder);
            stroke-width: 3;
        }
        
        .connection-temp {
            stroke: var(--vscode-focusBorder);
            stroke-dasharray: 5,5;
        }
        
        /* Properties */
        .properties {
            width: 250px;
            background: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
        }
        
        .properties-content {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }
        
        .properties-content .placeholder {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        
        .property-group {
            margin-bottom: 16px;
        }
        
        .property-label {
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .property-input {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 12px;
        }
        
        .property-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        textarea.property-input {
            min-height: 80px;
            resize: vertical;
        }
        
        /* Status Bar */
        .status-bar {
            display: flex;
            align-items: center;
            gap: 20px;
            padding: 4px 12px;
            background: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            font-size: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        `;
    }
    
    /**
     * Get JavaScript code
     */
    private getScript(): string {
        return `
        const vscode = acquireVsCodeApi();
        
        // State
        let graph = null;
        let nodePalette = {};
        let selectedNode = null;
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };
        let isPanning = false;
        let panStart = { x: 0, y: 0 };
        let canvasOffset = { x: 0, y: 0 };
        let zoom = 1;
        let isConnecting = false;
        let connectionStart = null;
        let tempConnectionLine = null;
        
        // DOM elements
        const canvasContainer = document.getElementById('canvas-container');
        const nodesContainer = document.getElementById('nodes-container');
        const connectionsSvg = document.getElementById('connections-svg');
        const paletteEl = document.getElementById('node-palette');
        const propertiesEl = document.getElementById('properties-content');
        const graphNameInput = document.getElementById('graph-name');
        const btnUndo = document.getElementById('btn-undo');
        const btnRedo = document.getElementById('btn-redo');
        const zoomLevelEl = document.getElementById('zoom-level');
        const nodeCountEl = document.getElementById('node-count');
        const connectionCountEl = document.getElementById('connection-count');
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            vscode.postMessage({ type: 'ready' });
            setupEventListeners();
        });
        
        // Event listeners
        function setupEventListeners() {
            // Toolbar buttons
            document.getElementById('btn-save').addEventListener('click', () => {
                vscode.postMessage({ type: 'save' });
            });
            
            document.getElementById('btn-new').addEventListener('click', () => {
                if (confirm('Create new workflow? Unsaved changes will be lost.')) {
                    graph = null;
                    nodesContainer.innerHTML = '';
                    connectionsSvg.innerHTML = '';
                    graphNameInput.value = 'New Workflow';
                    updateStats();
                }
            });
            
            btnUndo.addEventListener('click', () => {
                vscode.postMessage({ type: 'undo' });
            });
            
            btnRedo.addEventListener('click', () => {
                vscode.postMessage({ type: 'redo' });
            });
            
            document.getElementById('btn-zoom-fit').addEventListener('click', fitToView);
            
            graphNameInput.addEventListener('change', () => {
                if (graph) {
                    graph.name = graphNameInput.value;
                    vscode.postMessage({ type: 'updateGraphMeta', payload: { name: graph.name } });
                }
            });
            
            // Canvas events
            canvasContainer.addEventListener('wheel', handleZoom);
            canvasContainer.addEventListener('mousedown', handleCanvasMouseDown);
            canvasContainer.addEventListener('mousemove', handleCanvasMouseMove);
            canvasContainer.addEventListener('mouseup', handleCanvasMouseUp);
            canvasContainer.addEventListener('mouseleave', handleCanvasMouseUp);
            
            // Keyboard shortcuts
            document.addEventListener('keydown', handleKeyDown);
            
            // Drop zone
            canvasContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            });
            
            canvasContainer.addEventListener('drop', handleDrop);
        }
        
        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const { type, payload } = event.data;
            
            switch (type) {
                case 'nodePalette':
                    nodePalette = payload;
                    renderPalette();
                    break;
                    
                case 'loadGraph':
                    graph = payload.graph;
                    renderGraph();
                    graphNameInput.value = graph.name || 'Untitled';
                    updateStats();
                    break;
                    
                case 'nodeAdded':
                    if (graph) {
                        graph.nodes.push(payload.node);
                        renderNode(payload.node);
                        updateStats();
                    }
                    break;
                    
                case 'nodeDeleted':
                    if (graph) {
                        graph.nodes = graph.nodes.filter(n => n.id !== payload.nodeId);
                        document.getElementById('node-' + payload.nodeId)?.remove();
                        payload.connectionIds.forEach(id => {
                            document.getElementById('conn-' + id)?.remove();
                        });
                        updateStats();
                    }
                    break;
                    
                case 'nodeMoved':
                    const movedNode = graph?.nodes.find(n => n.id === payload.nodeId);
                    if (movedNode) {
                        movedNode.position = payload.position;
                        const nodeEl = document.getElementById('node-' + payload.nodeId);
                        if (nodeEl) {
                            nodeEl.style.left = payload.position.x + 'px';
                            nodeEl.style.top = payload.position.y + 'px';
                            updateConnections();
                        }
                    }
                    break;
                    
                case 'connectionAdded':
                    if (graph) {
                        graph.connections.push(payload.connection);
                        renderConnection(payload.connection);
                        updateStats();
                    }
                    break;
                    
                case 'connectionDeleted':
                    if (graph) {
                        graph.connections = graph.connections.filter(c => c.id !== payload.connectionId);
                        document.getElementById('conn-' + payload.connectionId)?.remove();
                        updateStats();
                    }
                    break;
                    
                case 'nodeConfigUpdated':
                    const configNode = graph?.nodes.find(n => n.id === payload.nodeId);
                    if (configNode) {
                        configNode.config = payload.config;
                        if (selectedNode?.id === payload.nodeId) {
                            renderProperties(configNode);
                        }
                    }
                    break;
                    
                case 'undoRedoState':
                    btnUndo.disabled = !payload.canUndo;
                    btnRedo.disabled = !payload.canRedo;
                    break;
            }
        });
        
        // Render palette
        function renderPalette() {
            paletteEl.innerHTML = '';
            
            const categories = ['flow', 'agent', 'actions', 'data', 'control', 'parallel'];
            
            for (const category of categories) {
                const nodes = nodePalette[category];
                if (!nodes || nodes.length === 0) continue;
                
                const categoryEl = document.createElement('div');
                categoryEl.className = 'palette-category';
                
                const headerEl = document.createElement('div');
                headerEl.className = 'category-header';
                headerEl.textContent = category.charAt(0).toUpperCase() + category.slice(1);
                categoryEl.appendChild(headerEl);
                
                for (const nodeDef of nodes) {
                    const nodeEl = document.createElement('div');
                    nodeEl.className = 'palette-node';
                    nodeEl.draggable = true;
                    nodeEl.dataset.type = nodeDef.type;
                    nodeEl.innerHTML = '<span>' + (nodeDef.icon || '⬤') + '</span><span>' + nodeDef.name + '</span>';
                    
                    nodeEl.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('nodeType', nodeDef.type);
                        nodeEl.classList.add('dragging');
                    });
                    
                    nodeEl.addEventListener('dragend', () => {
                        nodeEl.classList.remove('dragging');
                    });
                    
                    categoryEl.appendChild(nodeEl);
                }
                
                paletteEl.appendChild(categoryEl);
            }
        }
        
        // Handle drop
        function handleDrop(e) {
            e.preventDefault();
            const nodeType = e.dataTransfer.getData('nodeType');
            if (!nodeType) return;
            
            const rect = canvasContainer.getBoundingClientRect();
            const x = (e.clientX - rect.left - canvasOffset.x) / zoom;
            const y = (e.clientY - rect.top - canvasOffset.y) / zoom;
            
            vscode.postMessage({
                type: 'addNode',
                payload: { type: nodeType, position: { x, y } }
            });
        }
        
        // Render graph
        function renderGraph() {
            nodesContainer.innerHTML = '';
            connectionsSvg.innerHTML = '';
            
            if (!graph) return;
            
            // Apply editor state
            if (graph.editor) {
                zoom = graph.editor.zoom || 1;
                canvasOffset.x = graph.editor.panX || 0;
                canvasOffset.y = graph.editor.panY || 0;
                updateTransform();
            }
            
            // Render nodes
            for (const node of graph.nodes) {
                renderNode(node);
            }
            
            // Render connections
            for (const conn of graph.connections) {
                renderConnection(conn);
            }
        }
        
        // Render node
        function renderNode(node) {
            const nodeDef = Object.values(nodePalette).flat().find(d => d.type === node.type);
            
            const nodeEl = document.createElement('div');
            nodeEl.className = 'node';
            nodeEl.id = 'node-' + node.id;
            nodeEl.style.left = (node.position?.x || 0) + 'px';
            nodeEl.style.top = (node.position?.y || 0) + 'px';
            
            // Header
            const headerEl = document.createElement('div');
            headerEl.className = 'node-header';
            headerEl.style.background = nodeDef?.color || 'var(--vscode-badge-background)';
            headerEl.innerHTML = '<span>' + (nodeDef?.icon || '⬤') + '</span><span>' + (node.label || nodeDef?.name || node.type) + '</span>';
            nodeEl.appendChild(headerEl);
            
            // Body with ports
            const bodyEl = document.createElement('div');
            bodyEl.className = 'node-body';
            
            // Input ports
            for (const port of node.inputs || []) {
                const portEl = document.createElement('div');
                portEl.className = 'node-port input';
                portEl.innerHTML = '<div class="port-dot input" data-node="' + node.id + '" data-port="' + port.id + '" data-direction="input"></div><span>' + port.name + '</span>';
                bodyEl.appendChild(portEl);
            }
            
            // Output ports
            for (const port of node.outputs || []) {
                const portEl = document.createElement('div');
                portEl.className = 'node-port output';
                portEl.innerHTML = '<span>' + port.name + '</span><div class="port-dot output" data-node="' + node.id + '" data-port="' + port.id + '" data-direction="output"></div>';
                bodyEl.appendChild(portEl);
            }
            
            nodeEl.appendChild(bodyEl);
            nodesContainer.appendChild(nodeEl);
            
            // Node events
            nodeEl.addEventListener('mousedown', (e) => handleNodeMouseDown(e, node));
            nodeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                selectNode(node);
            });
            
            // Port events
            nodeEl.querySelectorAll('.port-dot').forEach(portEl => {
                portEl.addEventListener('mousedown', (e) => handlePortMouseDown(e));
            });
        }
        
        // Render connection
        function renderConnection(conn) {
            const fromNode = document.getElementById('node-' + conn.fromNodeId);
            const toNode = document.getElementById('node-' + conn.toNodeId);
            if (!fromNode || !toNode) return;
            
            const fromPort = fromNode.querySelector('[data-port="' + conn.fromPortId + '"]');
            const toPort = toNode.querySelector('[data-port="' + conn.toPortId + '"]');
            if (!fromPort || !toPort) return;
            
            const fromRect = fromPort.getBoundingClientRect();
            const toRect = toPort.getBoundingClientRect();
            const containerRect = canvasContainer.getBoundingClientRect();
            
            const x1 = (fromRect.left + fromRect.width/2 - containerRect.left - canvasOffset.x) / zoom;
            const y1 = (fromRect.top + fromRect.height/2 - containerRect.top - canvasOffset.y) / zoom;
            const x2 = (toRect.left + toRect.width/2 - containerRect.left - canvasOffset.x) / zoom;
            const y2 = (toRect.top + toRect.height/2 - containerRect.top - canvasOffset.y) / zoom;
            
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.id = 'conn-' + conn.id;
            path.className.baseVal = 'connection';
            path.setAttribute('d', createCurvePath(x1, y1, x2, y2));
            path.dataset.connId = conn.id;
            
            path.addEventListener('click', () => {
                if (confirm('Delete this connection?')) {
                    vscode.postMessage({ type: 'deleteConnection', payload: { connectionId: conn.id } });
                }
            });
            
            connectionsSvg.appendChild(path);
        }
        
        // Create bezier curve path
        function createCurvePath(x1, y1, x2, y2) {
            const dx = Math.abs(x2 - x1) / 2;
            return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
        }
        
        // Update all connections
        function updateConnections() {
            connectionsSvg.innerHTML = '';
            if (graph) {
                for (const conn of graph.connections) {
                    renderConnection(conn);
                }
            }
        }
        
        // Select node
        function selectNode(node) {
            document.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
            selectedNode = node;
            
            const nodeEl = document.getElementById('node-' + node.id);
            if (nodeEl) nodeEl.classList.add('selected');
            
            renderProperties(node);
        }
        
        // Render properties panel
        function renderProperties(node) {
            const nodeDef = Object.values(nodePalette).flat().find(d => d.type === node.type);
            
            let html = '<div class="property-group">';
            html += '<div class="property-label">Node ID</div>';
            html += '<input type="text" class="property-input" value="' + node.id + '" readonly>';
            html += '</div>';
            
            html += '<div class="property-group">';
            html += '<div class="property-label">Type</div>';
            html += '<input type="text" class="property-input" value="' + (nodeDef?.name || node.type) + '" readonly>';
            html += '</div>';
            
            // Config fields
            if (nodeDef?.configSchema?.fields) {
                for (const field of nodeDef.configSchema.fields) {
                    const value = node.config?.[field.name] ?? field.defaultValue ?? '';
                    
                    html += '<div class="property-group">';
                    html += '<div class="property-label">' + field.label + '</div>';
                    
                    if (field.type === 'boolean') {
                        html += '<input type="checkbox" class="property-input" data-field="' + field.name + '" ' + (value ? 'checked' : '') + '>';
                    } else if (field.type === 'number') {
                        html += '<input type="number" class="property-input" data-field="' + field.name + '" value="' + value + '"' + 
                                (field.min !== undefined ? ' min="' + field.min + '"' : '') +
                                (field.max !== undefined ? ' max="' + field.max + '"' : '') + '>';
                    } else if (field.type === 'select') {
                        html += '<select class="property-input" data-field="' + field.name + '">';
                        for (const opt of field.options || []) {
                            html += '<option value="' + opt.value + '"' + (value === opt.value ? ' selected' : '') + '>' + opt.label + '</option>';
                        }
                        html += '</select>';
                    } else if (field.type === 'multiline' || field.type === 'template') {
                        html += '<textarea class="property-input" data-field="' + field.name + '">' + (value || '') + '</textarea>';
                    } else {
                        html += '<input type="text" class="property-input" data-field="' + field.name + '" value="' + (value || '') + '">';
                    }
                    
                    html += '</div>';
                }
            }
            
            // Delete button
            if (node.type !== 'start') {
                html += '<div class="property-group">';
                html += '<button onclick="deleteSelectedNode()" style="width:100%;padding:8px;background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-inputValidation-errorForeground);border:none;border-radius:4px;cursor:pointer;">Delete Node</button>';
                html += '</div>';
            }
            
            propertiesEl.innerHTML = html;
            
            // Add change listeners
            propertiesEl.querySelectorAll('.property-input[data-field]').forEach(input => {
                const fieldName = input.dataset.field;
                
                input.addEventListener('change', () => {
                    let value;
                    if (input.type === 'checkbox') {
                        value = input.checked;
                    } else if (input.type === 'number') {
                        value = parseFloat(input.value);
                    } else {
                        value = input.value;
                    }
                    
                    vscode.postMessage({
                        type: 'updateNodeConfig',
                        payload: { nodeId: node.id, config: { [fieldName]: value } }
                    });
                });
            });
        }
        
        // Delete selected node
        window.deleteSelectedNode = function() {
            if (selectedNode && selectedNode.type !== 'start') {
                vscode.postMessage({ type: 'deleteNode', payload: { nodeId: selectedNode.id } });
                selectedNode = null;
                propertiesEl.innerHTML = '<p class="placeholder">Select a node to edit its properties</p>';
            }
        };
        
        // Node mouse handlers
        function handleNodeMouseDown(e, node) {
            if (e.target.classList.contains('port-dot')) return;
            
            isDragging = true;
            selectedNode = node;
            
            const nodeEl = document.getElementById('node-' + node.id);
            const rect = nodeEl.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            
            e.preventDefault();
        }
        
        // Port mouse handlers
        function handlePortMouseDown(e) {
            e.stopPropagation();
            const portEl = e.target;
            const nodeId = portEl.dataset.node;
            const portId = portEl.dataset.port;
            const direction = portEl.dataset.direction;
            
            if (direction === 'output') {
                isConnecting = true;
                connectionStart = { nodeId, portId };
                
                // Create temp line
                tempConnectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                tempConnectionLine.className.baseVal = 'connection connection-temp';
                connectionsSvg.appendChild(tempConnectionLine);
            }
        }
        
        // Canvas mouse handlers
        function handleCanvasMouseDown(e) {
            if (e.target === canvasContainer || e.target === nodesContainer) {
                // Deselect node
                document.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
                selectedNode = null;
                propertiesEl.innerHTML = '<p class="placeholder">Select a node to edit its properties</p>';
                
                // Start panning
                if (e.button === 1 || e.button === 0 && e.shiftKey) {
                    isPanning = true;
                    panStart.x = e.clientX - canvasOffset.x;
                    panStart.y = e.clientY - canvasOffset.y;
                    e.preventDefault();
                }
            }
        }
        
        function handleCanvasMouseMove(e) {
            if (isDragging && selectedNode) {
                const containerRect = canvasContainer.getBoundingClientRect();
                const x = (e.clientX - containerRect.left - dragOffset.x - canvasOffset.x) / zoom;
                const y = (e.clientY - containerRect.top - dragOffset.y - canvasOffset.y) / zoom;
                
                const nodeEl = document.getElementById('node-' + selectedNode.id);
                if (nodeEl) {
                    nodeEl.style.left = x + 'px';
                    nodeEl.style.top = y + 'px';
                    updateConnections();
                }
            }
            
            if (isPanning) {
                canvasOffset.x = e.clientX - panStart.x;
                canvasOffset.y = e.clientY - panStart.y;
                updateTransform();
                updateConnections();
            }
            
            if (isConnecting && tempConnectionLine) {
                const startPortEl = document.querySelector('[data-node="' + connectionStart.nodeId + '"][data-port="' + connectionStart.portId + '"]');
                if (startPortEl) {
                    const startRect = startPortEl.getBoundingClientRect();
                    const containerRect = canvasContainer.getBoundingClientRect();
                    
                    const x1 = (startRect.left + startRect.width/2 - containerRect.left - canvasOffset.x) / zoom;
                    const y1 = (startRect.top + startRect.height/2 - containerRect.top - canvasOffset.y) / zoom;
                    const x2 = (e.clientX - containerRect.left - canvasOffset.x) / zoom;
                    const y2 = (e.clientY - containerRect.top - canvasOffset.y) / zoom;
                    
                    tempConnectionLine.setAttribute('d', createCurvePath(x1, y1, x2, y2));
                }
            }
        }
        
        function handleCanvasMouseUp(e) {
            if (isDragging && selectedNode) {
                const containerRect = canvasContainer.getBoundingClientRect();
                const x = (e.clientX - containerRect.left - dragOffset.x - canvasOffset.x) / zoom;
                const y = (e.clientY - containerRect.top - dragOffset.y - canvasOffset.y) / zoom;
                
                vscode.postMessage({
                    type: 'moveNode',
                    payload: { nodeId: selectedNode.id, position: { x, y } }
                });
            }
            
            if (isConnecting) {
                // Check if dropped on an input port
                const targetPort = e.target.closest('.port-dot[data-direction="input"]');
                if (targetPort && connectionStart) {
                    const toNodeId = targetPort.dataset.node;
                    const toPortId = targetPort.dataset.port;
                    
                    if (toNodeId !== connectionStart.nodeId) {
                        vscode.postMessage({
                            type: 'addConnection',
                            payload: {
                                fromNodeId: connectionStart.nodeId,
                                fromPortId: connectionStart.portId,
                                toNodeId,
                                toPortId
                            }
                        });
                    }
                }
                
                if (tempConnectionLine) {
                    tempConnectionLine.remove();
                    tempConnectionLine = null;
                }
            }
            
            isDragging = false;
            isPanning = false;
            isConnecting = false;
            connectionStart = null;
        }
        
        // Zoom handler
        function handleZoom(e) {
            e.preventDefault();
            
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            const newZoom = Math.max(0.25, Math.min(2, zoom + delta));
            
            // Zoom towards mouse position
            const rect = canvasContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const zoomRatio = newZoom / zoom;
            canvasOffset.x = mouseX - (mouseX - canvasOffset.x) * zoomRatio;
            canvasOffset.y = mouseY - (mouseY - canvasOffset.y) * zoomRatio;
            
            zoom = newZoom;
            updateTransform();
            updateConnections();
            
            zoomLevelEl.textContent = Math.round(zoom * 100) + '%';
            
            // Save editor state
            vscode.postMessage({
                type: 'updateEditorState',
                payload: { zoom, panX: canvasOffset.x, panY: canvasOffset.y }
            });
        }
        
        // Update canvas transform
        function updateTransform() {
            nodesContainer.style.transform = 'translate(' + canvasOffset.x + 'px, ' + canvasOffset.y + 'px) scale(' + zoom + ')';
            zoomLevelEl.textContent = Math.round(zoom * 100) + '%';
        }
        
        // Fit to view
        function fitToView() {
            if (!graph || graph.nodes.length === 0) return;
            
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            
            for (const node of graph.nodes) {
                const x = node.position?.x || 0;
                const y = node.position?.y || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + 150);
                maxY = Math.max(maxY, y + 100);
            }
            
            const rect = canvasContainer.getBoundingClientRect();
            const contentWidth = maxX - minX + 100;
            const contentHeight = maxY - minY + 100;
            
            zoom = Math.min(rect.width / contentWidth, rect.height / contentHeight, 1);
            canvasOffset.x = (rect.width - contentWidth * zoom) / 2 - minX * zoom;
            canvasOffset.y = (rect.height - contentHeight * zoom) / 2 - minY * zoom;
            
            updateTransform();
            updateConnections();
        }
        
        // Keyboard shortcuts
        function handleKeyDown(e) {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 's') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'save' });
                } else if (e.key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    vscode.postMessage({ type: 'undo' });
                } else if (e.key === 'z' && e.shiftKey || e.key === 'y') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'redo' });
                }
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedNode && selectedNode.type !== 'start' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
                    vscode.postMessage({ type: 'deleteNode', payload: { nodeId: selectedNode.id } });
                    selectedNode = null;
                    propertiesEl.innerHTML = '<p class="placeholder">Select a node to edit its properties</p>';
                }
            }
        }
        
        // Update stats
        function updateStats() {
            nodeCountEl.textContent = 'Nodes: ' + (graph?.nodes?.length || 0);
            connectionCountEl.textContent = 'Connections: ' + (graph?.connections?.length || 0);
        }
        `;
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

