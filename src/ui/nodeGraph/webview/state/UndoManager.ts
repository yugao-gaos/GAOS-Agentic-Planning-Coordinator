// ============================================================================
// UndoManager - Undo/redo with action batching
// ============================================================================

/**
 * Get the UndoManager module code for the webview
 */
export function getUndoManagerCode(): string {
    return `
// ============================================================================
// UndoManager - Undo/redo system with batching support
// ============================================================================

const UndoManager = {
    undoStack: [],
    redoStack: [],
    maxSize: 50,
    batchActions: null, // Used for batching multiple actions into one undo step
    
    // Start a batch operation (multiple actions = one undo step)
    startBatch() {
        this.batchActions = [];
    },
    
    // End batch and push as single undo action
    endBatch(description = 'batch') {
        if (this.batchActions && this.batchActions.length > 0) {
            this.undoStack.push({
                type: 'batch',
                description,
                actions: this.batchActions
            });
            
            if (this.undoStack.length > this.maxSize) {
                this.undoStack.shift();
            }
            
            this.redoStack = [];
        }
        this.batchActions = null;
        this.updateUI();
    },
    
    // Cancel batch without pushing
    cancelBatch() {
        this.batchActions = null;
    },
    
    // Push an action to undo stack (or batch if active)
    push(action) {
        if (this.batchActions) {
            this.batchActions.push(action);
        } else {
            this.undoStack.push(action);
            if (this.undoStack.length > this.maxSize) {
                this.undoStack.shift();
            }
            this.redoStack = [];
        }
        this.updateUI();
    },
    
    // Undo last action
    undo() {
        if (this.undoStack.length === 0) return;
        
        const action = this.undoStack.pop();
        this.redoStack.push(action);
        
        if (action.type === 'batch') {
            // Undo in reverse order
            for (let i = action.actions.length - 1; i >= 0; i--) {
                this.applyUndo(action.actions[i]);
            }
        } else {
            this.applyUndo(action);
        }
        
        this.updateUI();
    },
    
    // Redo last undone action
    redo() {
        if (this.redoStack.length === 0) return;
        
        const action = this.redoStack.pop();
        this.undoStack.push(action);
        
        if (action.type === 'batch') {
            // Redo in original order
            for (const subAction of action.actions) {
                this.applyRedo(subAction);
            }
        } else {
            this.applyRedo(action);
        }
        
        this.updateUI();
    },
    
    // Apply undo for a single action
    applyUndo(action) {
        switch (action.type) {
            case 'add_node':
                // Undo add = remove node
                if (GraphState.graph) {
                    const idx = GraphState.graph.nodes.findIndex(n => n.id === action.data.node.id);
                    if (idx >= 0) {
                        GraphState.graph.nodes.splice(idx, 1);
                        NodeRenderer.removeNode(action.data.node.id);
                    }
                }
                break;
                
            case 'delete_node':
                // Undo delete = add back node and connections
                if (GraphState.graph) {
                    GraphState.graph.nodes.push(action.data.node);
                    NodeRenderer.renderNode(action.data.node);
                    if (action.data.connections) {
                        for (const conn of action.data.connections) {
                            GraphState.graph.connections.push(conn);
                            ConnectionRenderer.renderConnection(conn);
                        }
                    }
                }
                break;
                
            case 'move_node':
            case 'move_nodes':
                // Undo move = restore old positions
                if (GraphState.graph && action.data.oldPositions) {
                    for (const [nodeId, pos] of Object.entries(action.data.oldPositions)) {
                        const node = GraphState.getNode(nodeId);
                        if (node) {
                            node.position = { ...pos };
                            NodeRenderer.updateNodePosition(nodeId, pos);
                        }
                    }
                    ConnectionRenderer.updateAllConnections();
                }
                break;
                
            case 'add_connection':
                // Undo add = remove connection
                if (GraphState.graph) {
                    const idx = GraphState.graph.connections.findIndex(c => c.id === action.data.connection.id);
                    if (idx >= 0) {
                        GraphState.graph.connections.splice(idx, 1);
                        ConnectionRenderer.removeConnection(action.data.connection.id);
                    }
                }
                break;
                
            case 'delete_connection':
                // Undo delete = add back connection
                if (GraphState.graph) {
                    GraphState.graph.connections.push(action.data.connection);
                    ConnectionRenderer.renderConnection(action.data.connection);
                }
                break;
                
            case 'update_config':
                // Undo config update = restore old config
                if (GraphState.graph) {
                    const node = GraphState.getNode(action.data.nodeId);
                    if (node) {
                        node.config = { ...action.data.oldConfig };
                        if (GraphState.selectedNodeIds.has(action.data.nodeId)) {
                            PropertyPanel.render(node);
                        }
                    }
                }
                break;
        }
        
        StatusBar.update();
    },
    
    // Apply redo for a single action
    applyRedo(action) {
        switch (action.type) {
            case 'add_node':
                if (GraphState.graph) {
                    GraphState.graph.nodes.push(action.data.node);
                    NodeRenderer.renderNode(action.data.node);
                }
                break;
                
            case 'delete_node':
                if (GraphState.graph) {
                    const idx = GraphState.graph.nodes.findIndex(n => n.id === action.data.node.id);
                    if (idx >= 0) {
                        GraphState.graph.nodes.splice(idx, 1);
                        NodeRenderer.removeNode(action.data.node.id);
                    }
                    if (action.data.connections) {
                        for (const conn of action.data.connections) {
                            const connIdx = GraphState.graph.connections.findIndex(c => c.id === conn.id);
                            if (connIdx >= 0) {
                                GraphState.graph.connections.splice(connIdx, 1);
                                ConnectionRenderer.removeConnection(conn.id);
                            }
                        }
                    }
                }
                break;
                
            case 'move_node':
            case 'move_nodes':
                if (GraphState.graph && action.data.newPositions) {
                    for (const [nodeId, pos] of Object.entries(action.data.newPositions)) {
                        const node = GraphState.getNode(nodeId);
                        if (node) {
                            node.position = { ...pos };
                            NodeRenderer.updateNodePosition(nodeId, pos);
                        }
                    }
                    ConnectionRenderer.updateAllConnections();
                }
                break;
                
            case 'add_connection':
                if (GraphState.graph) {
                    GraphState.graph.connections.push(action.data.connection);
                    ConnectionRenderer.renderConnection(action.data.connection);
                }
                break;
                
            case 'delete_connection':
                if (GraphState.graph) {
                    const idx = GraphState.graph.connections.findIndex(c => c.id === action.data.connection.id);
                    if (idx >= 0) {
                        GraphState.graph.connections.splice(idx, 1);
                        ConnectionRenderer.removeConnection(action.data.connection.id);
                    }
                }
                break;
                
            case 'update_config':
                if (GraphState.graph) {
                    const node = GraphState.getNode(action.data.nodeId);
                    if (node) {
                        node.config = { ...action.data.newConfig };
                        if (GraphState.selectedNodeIds.has(action.data.nodeId)) {
                            PropertyPanel.render(node);
                        }
                    }
                }
                break;
        }
        
        StatusBar.update();
    },
    
    // Update UI buttons
    updateUI() {
        const btnUndo = document.getElementById('btn-undo');
        const btnRedo = document.getElementById('btn-redo');
        
        if (btnUndo) btnUndo.disabled = this.undoStack.length === 0;
        if (btnRedo) btnRedo.disabled = this.redoStack.length === 0;
    },
    
    // Clear history
    clear() {
        this.undoStack = [];
        this.redoStack = [];
        this.batchActions = null;
        this.updateUI();
    },
    
    // Check if can undo/redo
    canUndo() { return this.undoStack.length > 0; },
    canRedo() { return this.redoStack.length > 0; }
};
`;
}

