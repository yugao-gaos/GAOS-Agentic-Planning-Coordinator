// ============================================================================
// Node Graph Editor Webview - Entry point
// ============================================================================

import { getStyles } from './styles';
import { getGraphStateCode, getUndoManagerCode } from './state';
import {
    getCanvasCode,
    getNodeRendererCode,
    getConnectionRendererCode,
    getPaletteCode,
    getPropertyPanelCode,
    getToolbarCode,
    getContextMenuCode,
    getMinimapCode,
    getQuickAddCode,
    getValidationPanelCode,
    getStatusBarCode,
    getBreadcrumbCode
} from './components';
import {
    getSelectionManagerCode,
    getDragManagerCode,
    getConnectionManagerCode,
    getKeyboardManagerCode,
    getClipboardManagerCode
} from './interactions';

/**
 * Get the complete webview HTML content
 */
export function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Node Workflow Editor</title>
    <style>
        ${getStyles()}
    </style>
</head>
<body>
    <div class="editor-container">
        <!-- Breadcrumb (for subgraph navigation) -->
        <div id="breadcrumb" class="breadcrumb hidden"></div>
        
        <!-- Toolbar -->
        <div class="toolbar">
            <div class="toolbar-left">
                <input type="text" id="graph-name" placeholder="Workflow Name" value="New Workflow">
                <span class="separator"></span>
                <button id="btn-undo" title="Undo (Ctrl+Z)" disabled>↩ Undo</button>
                <button id="btn-redo" title="Redo (Ctrl+Y)" disabled>↪ Redo</button>
            </div>
            <div class="toolbar-center">
                <div class="view-mode-toggle">
                    <button id="btn-view-exec" class="view-mode-btn" title="Show Execution Flow">Execution</button>
                    <button id="btn-view-data" class="view-mode-btn" title="Show Data Flow">Data</button>
                    <button id="btn-view-all" class="view-mode-btn active" title="Show All">All</button>
                </div>
                <span class="separator"></span>
                <button id="btn-grid-snap" class="active" title="Snap to Grid">⊞</button>
                <span class="separator"></span>
                <div class="zoom-control">
                    <button id="btn-zoom-fit" title="Fit to View">⊡</button>
                    <input type="range" id="zoom-slider" min="0.25" max="2" step="0.05" value="1">
                    <span id="zoom-display" class="zoom-display">100%</span>
                </div>
            </div>
            <div class="toolbar-right">
                <button id="btn-minimap" class="active" title="Toggle Minimap">🗺</button>
                <button id="btn-validation" title="Toggle Validation">⚠</button>
                <span class="separator"></span>
                <button id="btn-save" title="Save (Ctrl+S)">💾 Save</button>
                <button id="btn-save-as" title="Save As...">💾 Save As</button>
            </div>
        </div>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Node Palette -->
            <div class="palette">
                <div class="palette-header">Nodes</div>
                <div class="palette-search">
                    <input type="text" id="palette-search" placeholder="Search nodes...">
                </div>
                <div id="palette-content" class="palette-content">
                    <!-- Categories and nodes will be populated -->
                </div>
            </div>
            
            <!-- Canvas -->
            <div class="canvas-container" id="canvas-container">
                <svg id="connections-svg" class="connections-layer"></svg>
                <div id="nodes-layer" class="nodes-layer"></div>
                
                <!-- Minimap -->
                <div id="minimap" class="minimap">
                    <div class="minimap-content"></div>
                </div>
                
                <!-- Validation Panel -->
                <div id="validation-panel" class="validation-panel hidden"></div>
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
        <div class="status-bar" id="status-bar">
            <span id="status-text">Ready</span>
            <span id="selection-count"></span>
            <span id="node-count">Nodes: 0</span>
            <span id="connection-count">Connections: 0</span>
            <span id="validation-badge" class="validation-badge" style="display: none;" onclick="ValidationPanel.show()">0</span>
        </div>
    </div>
    
    <script>
        // ====================================================================
        // VS Code API
        // ====================================================================
        const vscode = acquireVsCodeApi();
        
        // ====================================================================
        // State Management
        // ====================================================================
        ${getGraphStateCode()}
        
        ${getUndoManagerCode()}
        
        // ====================================================================
        // Components
        // ====================================================================
        ${getCanvasCode()}
        
        ${getNodeRendererCode()}
        
        ${getConnectionRendererCode()}
        
        ${getPaletteCode()}
        
        ${getPropertyPanelCode()}
        
        ${getToolbarCode()}
        
        ${getContextMenuCode()}
        
        ${getMinimapCode()}
        
        ${getQuickAddCode()}
        
        ${getValidationPanelCode()}
        
        ${getStatusBarCode()}
        
        
        ${getBreadcrumbCode()}
        
        // ====================================================================
        // Interactions
        // ====================================================================
        ${getSelectionManagerCode()}
        
        ${getDragManagerCode()}
        
        ${getConnectionManagerCode()}
        
        ${getKeyboardManagerCode()}
        
        ${getClipboardManagerCode()}
        
        // ====================================================================
        // Initialization
        // ====================================================================
        document.addEventListener('DOMContentLoaded', () => {
            // Initialize all modules
            GraphState.init();
            Canvas.init();
            NodeRenderer.init();
            ConnectionRenderer.init();
            Palette.init();
            PropertyPanel.init();
            Toolbar.init();
            ContextMenu.init();
            Minimap.init();
            ValidationPanel.init();
            StatusBar.init();
            Breadcrumb.init();
            KeyboardManager.init();
            
            // Notify extension we're ready
            vscode.postMessage({ type: 'ready' });
        });
        
        // ====================================================================
        // Message Handler
        // ====================================================================
        window.addEventListener('message', (event) => {
            const { type, payload } = event.data;
            
            switch (type) {
                case 'nodePalette':
                    GraphState.nodePalette = payload;
                    Palette.render();
                    break;
                    
                case 'dynamicOptions':
                    GraphState.dynamicOptions = payload;
                    // Re-render property panel if a node is selected to update dropdowns
                    if (GraphState.selectedNodeIds.size === 1) {
                        const nodeId = Array.from(GraphState.selectedNodeIds)[0];
                        const node = GraphState.getNode(nodeId);
                        if (node) PropertyPanel.render(node);
                    }
                    break;
                    
                case 'loadGraph':
                    GraphState.graph = payload.graph;
                    GraphState.filePath = payload.filePath;
                    
                    // Apply editor state
                    if (payload.graph?.editor) {
                        GraphState.zoom = payload.graph.editor.zoom || 1;
                        GraphState.panX = payload.graph.editor.panX || 0;
                        GraphState.panY = payload.graph.editor.panY || 0;
                    }
                    
                    // Update UI
                    const nameInput = document.getElementById('graph-name');
                    if (nameInput) nameInput.value = payload.graph?.name || 'Untitled';
                    
                    // Render
                    Canvas.updateTransform();
                    NodeRenderer.renderAll();
                    ConnectionRenderer.renderAll();
                    Minimap.update();
                    StatusBar.update();
                    PropertyPanel.renderEmpty();
                    Toolbar.updateZoomDisplay();
                    UndoManager.clear();
                    
                    // Validate
                    GraphState.validate();
                    break;
                    
                case 'nodeAdded':
                    if (GraphState.graph) {
                        GraphState.graph.nodes.push(payload.node);
                        NodeRenderer.renderNode(payload.node);
                        StatusBar.update();
                        Minimap.update();
                        
                        // Select the new node
                        GraphState.selectNode(payload.node.id, false);
                        
                        // Validate
                        GraphState.validate();
                    }
                    break;
                    
                case 'nodeDeleted':
                case 'nodesDeleted':
                    if (GraphState.graph) {
                        const nodeIds = payload.nodeIds || [payload.nodeId];
                        
                        for (const nodeId of nodeIds) {
                            // Remove from graph
                            const idx = GraphState.graph.nodes.findIndex(n => n.id === nodeId);
                            if (idx >= 0) {
                                GraphState.graph.nodes.splice(idx, 1);
                            }
                            
                            // Remove from DOM
                            NodeRenderer.removeNode(nodeId);
                            
                            // Remove from selection
                            GraphState.selectedNodeIds.delete(nodeId);
                        }
                        
                        // Remove associated connections
                        const connIds = payload.connectionIds || [];
                        for (const connId of connIds) {
                            const connIdx = GraphState.graph.connections.findIndex(c => c.id === connId);
                            if (connIdx >= 0) {
                                GraphState.graph.connections.splice(connIdx, 1);
                            }
                            ConnectionRenderer.removeConnection(connId);
                        }
                        
                        ConnectionRenderer.updateAllConnections();
                        StatusBar.update();
                        Minimap.update();
                        PropertyPanel.renderEmpty();
                        GraphState.validate();
                    }
                    break;
                    
                case 'nodeMoved':
                case 'nodesMoved':
                    if (GraphState.graph && payload.positions) {
                        for (const [nodeId, pos] of Object.entries(payload.positions)) {
                            const node = GraphState.getNode(nodeId);
                            if (node) {
                                node.position = pos;
                                NodeRenderer.updateNodePosition(nodeId, pos);
                            }
                        }
                        ConnectionRenderer.updateAllConnections();
                        Minimap.update();
                    }
                    break;
                    
                case 'connectionAdded':
                    if (GraphState.graph) {
                        GraphState.graph.connections.push(payload.connection);
                        ConnectionRenderer.renderConnection(payload.connection);
                        StatusBar.update();
                        GraphState.validate();
                    }
                    break;
                    
                case 'connectionDeleted':
                    if (GraphState.graph) {
                        const idx = GraphState.graph.connections.findIndex(c => c.id === payload.connectionId);
                        if (idx >= 0) {
                            GraphState.graph.connections.splice(idx, 1);
                        }
                        ConnectionRenderer.removeConnection(payload.connectionId);
                        StatusBar.update();
                        GraphState.validate();
                    }
                    break;
                    
                case 'nodeConfigUpdated':
                    if (GraphState.graph) {
                        const node = GraphState.getNode(payload.nodeId);
                        if (node) {
                            node.config = { ...node.config, ...payload.config };
                            if (GraphState.selectedNodeIds.has(payload.nodeId)) {
                                PropertyPanel.render(node);
                            }
                        }
                    }
                    break;
                    
                case 'nodeUpdated':
                    // Full node update (e.g., dynamic ports changed)
                    if (GraphState.graph && payload.node) {
                        const idx = GraphState.graph.nodes.findIndex(n => n.id === payload.node.id);
                        if (idx >= 0) {
                            GraphState.graph.nodes[idx] = payload.node;
                            NodeRenderer.removeNode(payload.node.id);
                            NodeRenderer.renderNode(payload.node);
                            ConnectionRenderer.updateAllConnections();
                            if (GraphState.selectedNodeIds.has(payload.node.id)) {
                                PropertyPanel.render(payload.node);
                            }
                        }
                    }
                    break;
                    
                case 'nodesCreated':
                    // Handle paste response
                    if (GraphState.graph && payload.nodes) {
                        for (const node of payload.nodes) {
                            GraphState.graph.nodes.push(node);
                            NodeRenderer.renderNode(node);
                        }
                        
                        if (payload.connections) {
                            for (const conn of payload.connections) {
                                GraphState.graph.connections.push(conn);
                                ConnectionRenderer.renderConnection(conn);
                            }
                        }
                        
                        // Select pasted nodes
                        GraphState.selectedNodeIds = new Set(payload.nodes.map(n => n.id));
                        NodeRenderer.updateSelection();
                        
                        StatusBar.update();
                        Minimap.update();
                        GraphState.validate();
                    }
                    break;
                    
                case 'undoRedoState':
                    document.getElementById('btn-undo').disabled = !payload.canUndo;
                    document.getElementById('btn-redo').disabled = !payload.canRedo;
                    break;
            }
        });
    </script>
</body>
</html>`;
}

