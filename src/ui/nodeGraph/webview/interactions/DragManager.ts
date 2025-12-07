// ============================================================================
// DragManager - Node dragging with snap
// ============================================================================

/**
 * Get the DragManager module code for the webview
 */
export function getDragManagerCode(): string {
    return `
// ============================================================================
// DragManager - Node dragging
// ============================================================================

const DragManager = {
    draggedNodeId: null,
    dragStartPositions: {},
    initialMousePos: null,
    
    // Start dragging
    startDrag(e, nodeId) {
        // If the node isn't selected, select only it
        if (!GraphState.selectedNodeIds.has(nodeId)) {
            GraphState.selectNode(nodeId, false);
        }
        
        GraphState.isDragging = true;
        this.draggedNodeId = nodeId;
        this.initialMousePos = Canvas.screenToCanvas(e.clientX, e.clientY);
        
        // Store initial positions of all selected nodes
        this.dragStartPositions = {};
        for (const id of GraphState.selectedNodeIds) {
            const node = GraphState.getNode(id);
            if (node) {
                this.dragStartPositions[id] = { ...node.position };
            }
        }
        
        // Add dragging class
        for (const id of GraphState.selectedNodeIds) {
            const nodeEl = document.getElementById('node-' + id);
            if (nodeEl) nodeEl.classList.add('dragging');
        }
    },
    
    // Handle drag movement
    handleDrag(e) {
        if (!GraphState.isDragging || !this.initialMousePos) return;
        
        const currentPos = Canvas.screenToCanvas(e.clientX, e.clientY);
        const deltaX = currentPos.x - this.initialMousePos.x;
        const deltaY = currentPos.y - this.initialMousePos.y;
        
        // Move all selected nodes
        for (const nodeId of GraphState.selectedNodeIds) {
            const startPos = this.dragStartPositions[nodeId];
            if (!startPos) continue;
            
            const node = GraphState.getNode(nodeId);
            if (!node) continue;
            
            let newX = startPos.x + deltaX;
            let newY = startPos.y + deltaY;
            
            // Apply grid snapping
            if (GraphState.snapToGrid) {
                newX = GraphState.snapToGridValue(newX);
                newY = GraphState.snapToGridValue(newY);
            }
            
            node.position = { x: newX, y: newY };
            NodeRenderer.updateNodePosition(nodeId, node.position);
        }
        
        ConnectionRenderer.updateAllConnections();
    },
    
    // End dragging
    endDrag(e) {
        if (!GraphState.isDragging) return;
        
        // Remove dragging class
        for (const id of GraphState.selectedNodeIds) {
            const nodeEl = document.getElementById('node-' + id);
            if (nodeEl) nodeEl.classList.remove('dragging');
        }
        
        // Calculate final positions
        const oldPositions = this.dragStartPositions;
        const newPositions = {};
        let hasMoved = false;
        
        for (const nodeId of GraphState.selectedNodeIds) {
            const node = GraphState.getNode(nodeId);
            if (node) {
                newPositions[nodeId] = { ...node.position };
                
                // Check if actually moved
                const oldPos = oldPositions[nodeId];
                if (oldPos && (oldPos.x !== node.position.x || oldPos.y !== node.position.y)) {
                    hasMoved = true;
                }
            }
        }
        
        // Only record undo and notify if moved
        if (hasMoved) {
            UndoManager.push({
                type: 'move_nodes',
                data: { oldPositions, newPositions }
            });
            
            vscode.postMessage({
                type: 'moveNodes',
                payload: { positions: newPositions }
            });
        }
        
        GraphState.isDragging = false;
        this.draggedNodeId = null;
        this.dragStartPositions = {};
        this.initialMousePos = null;
        
        Minimap.update();
    }
};
`;
}

