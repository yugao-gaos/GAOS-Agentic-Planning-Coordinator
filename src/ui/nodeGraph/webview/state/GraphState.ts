// ============================================================================
// GraphState - Central state management for the node graph editor
// ============================================================================

/**
 * Get the GraphState module code for the webview
 */
export function getGraphStateCode(): string {
    return `
// ============================================================================
// GraphState - Central state management
// ============================================================================

const GraphState = {
    // Graph data
    graph: null,
    filePath: null,
    nodePalette: {},
    dynamicOptions: {}, // Dynamic options for select fields (e.g., agentRoles)
    
    // Selection state
    selectedNodeIds: new Set(),
    selectedConnectionId: null,
    
    // Clipboard
    clipboard: null, // { nodes: [], connections: [] }
    
    // View state
    zoom: 1,
    panX: 0,
    panY: 0,
    gridSize: 20,
    snapToGrid: true,
    showMinimap: true,
    showValidation: false,
    viewMode: 'all', // 'execution', 'data', or 'all'
    
    // Interaction state
    isDragging: false,
    isPanning: false,
    isConnecting: false,
    isBoxSelecting: false,
    dragOffset: { x: 0, y: 0 },
    boxSelectStart: null,
    connectionStart: null,
    lastMousePos: { x: 0, y: 0 },
    
    // Subgraph navigation
    navigationStack: [], // Array of { graphName, graph }
    currentSubgraphNodeId: null,
    
    // Validation
    validationErrors: [],
    
    // Event listeners
    listeners: {},
    
    // Initialize state
    init() {
        this.graph = null;
        this.selectedNodeIds = new Set();
        this.selectedConnectionId = null;
        this.clipboard = null;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.validationErrors = [];
    },
    
    // Event emitter methods
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    },
    
    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    },
    
    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    },
    
    // Selection methods
    selectNode(nodeId, addToSelection = false) {
        if (!addToSelection) {
            this.selectedNodeIds.clear();
        }
        this.selectedNodeIds.add(nodeId);
        this.selectedConnectionId = null;
        this.emit('selectionChanged', { nodeIds: Array.from(this.selectedNodeIds) });
    },
    
    deselectNode(nodeId) {
        this.selectedNodeIds.delete(nodeId);
        this.emit('selectionChanged', { nodeIds: Array.from(this.selectedNodeIds) });
    },
    
    toggleNodeSelection(nodeId) {
        if (this.selectedNodeIds.has(nodeId)) {
            this.selectedNodeIds.delete(nodeId);
        } else {
            this.selectedNodeIds.add(nodeId);
        }
        this.selectedConnectionId = null;
        this.emit('selectionChanged', { nodeIds: Array.from(this.selectedNodeIds) });
    },
    
    selectAllNodes() {
        if (this.graph && this.graph.nodes) {
            this.selectedNodeIds = new Set(this.graph.nodes.map(n => n.id));
            this.selectedConnectionId = null;
            this.emit('selectionChanged', { nodeIds: Array.from(this.selectedNodeIds) });
        }
    },
    
    selectNodesInRect(rect) {
        if (!this.graph) return;
        
        const selectedIds = [];
        for (const node of this.graph.nodes) {
            const nodeX = node.position?.x || 0;
            const nodeY = node.position?.y || 0;
            const nodeW = 150; // Approximate width
            const nodeH = 80;  // Approximate height
            
            // Check if node intersects with selection rect
            if (nodeX < rect.x + rect.width &&
                nodeX + nodeW > rect.x &&
                nodeY < rect.y + rect.height &&
                nodeY + nodeH > rect.y) {
                selectedIds.push(node.id);
            }
        }
        
        this.selectedNodeIds = new Set(selectedIds);
        this.selectedConnectionId = null;
        this.emit('selectionChanged', { nodeIds: selectedIds });
    },
    
    clearSelection() {
        this.selectedNodeIds.clear();
        this.selectedConnectionId = null;
        this.emit('selectionChanged', { nodeIds: [] });
    },
    
    selectConnection(connectionId) {
        this.selectedNodeIds.clear();
        this.selectedConnectionId = connectionId;
        this.emit('selectionChanged', { connectionId });
    },
    
    // Clipboard methods
    copySelection() {
        if (!this.graph || this.selectedNodeIds.size === 0) return;
        
        const selectedNodes = this.graph.nodes.filter(n => this.selectedNodeIds.has(n.id));
        const selectedNodeIdSet = new Set(selectedNodes.map(n => n.id));
        
        // Get connections between selected nodes
        const connections = this.graph.connections.filter(c => 
            selectedNodeIdSet.has(c.fromNodeId) && selectedNodeIdSet.has(c.toNodeId)
        );
        
        this.clipboard = {
            nodes: JSON.parse(JSON.stringify(selectedNodes)),
            connections: JSON.parse(JSON.stringify(connections))
        };
        
        return this.clipboard;
    },
    
    getClipboard() {
        return this.clipboard;
    },
    
    // Grid snap helper
    snapToGridValue(value) {
        if (!this.snapToGrid) return value;
        return Math.round(value / this.gridSize) * this.gridSize;
    },
    
    // Get selected nodes
    getSelectedNodes() {
        if (!this.graph) return [];
        return this.graph.nodes.filter(n => this.selectedNodeIds.has(n.id));
    },
    
    // Get node by ID
    getNode(nodeId) {
        if (!this.graph) return null;
        return this.graph.nodes.find(n => n.id === nodeId);
    },
    
    // Get connection by ID
    getConnection(connectionId) {
        if (!this.graph) return null;
        return this.graph.connections.find(c => c.id === connectionId);
    },
    
    // Validate graph
    validate() {
        if (!this.graph) {
            this.validationErrors = [];
            return [];
        }
        
        const errors = [];
        
        // Check for start node
        const startNodes = this.graph.nodes.filter(n => n.type === 'start');
        if (startNodes.length === 0) {
            errors.push({ nodeId: null, message: 'Graph must have a Start node' });
        } else if (startNodes.length > 1) {
            errors.push({ nodeId: startNodes[1].id, message: 'Graph can only have one Start node' });
        }
        
        // Check for end node
        const endNodes = this.graph.nodes.filter(n => n.type === 'end');
        if (endNodes.length === 0) {
            errors.push({ nodeId: null, message: 'Graph should have an End node' });
        }
        
        // Validate each node
        for (const node of this.graph.nodes) {
            // Check required connections
            for (const input of node.inputs || []) {
                if (input.required) {
                    const hasConnection = this.graph.connections.some(
                        c => c.toNodeId === node.id && c.toPortId === input.id
                    );
                    if (!hasConnection && input.defaultValue === undefined) {
                        errors.push({
                            nodeId: node.id,
                            message: \`Node "\${node.label || node.type}" missing required input "\${input.name}"\`
                        });
                    }
                }
            }
        }
        
        this.validationErrors = errors;
        this.emit('validationChanged', errors);
        return errors;
    }
};
`;
}

