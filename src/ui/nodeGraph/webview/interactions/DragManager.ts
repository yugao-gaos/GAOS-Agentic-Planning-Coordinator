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
    containedNodePositions: {}, // Track contained nodes for loop containers
    containedReroutePoints: {}, // Track reroute points inside loop containers
    rerouteLoopParents: {}, // Track which loop each reroute point belongs to
    
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
        this.containedNodePositions = {};
        this.containedReroutePoints = {};
        this.rerouteLoopParents = {};
        
        for (const id of GraphState.selectedNodeIds) {
            const node = GraphState.getNode(id);
            if (node) {
                this.dragStartPositions[id] = { ...node.position };
                
                // If this is a loop container, also track contained nodes and their reroute points
                if (node.type === 'for_loop' && node.config?.containedNodeIds) {
                    const containedIds = node.config.containedNodeIds.split(',').filter(s => s.trim());
                    for (const containedId of containedIds) {
                        const containedNode = GraphState.getNode(containedId.trim());
                        if (containedNode && !GraphState.selectedNodeIds.has(containedId.trim())) {
                            this.containedNodePositions[containedId.trim()] = { ...containedNode.position };
                        }
                    }
                    
                    // Track reroute points that are inside this loop container
                    this.trackContainedReroutePoints(node);
                }
            }
        }
        
        // Add dragging class
        for (const id of GraphState.selectedNodeIds) {
            const nodeEl = document.getElementById('node-' + id);
            if (nodeEl) nodeEl.classList.add('dragging');
        }
    },
    
    // Track reroute points that are inside a loop container
    trackContainedReroutePoints(loopNode) {
        const loopRect = {
            x: loopNode.position?.x || 0,
            y: (loopNode.position?.y || 0) + 35, // Below title bar
            width: loopNode.config?.width || 400,
            height: (loopNode.config?.height || 250) - 35
        };
        
        // Check all connections for reroute points inside this loop
        for (const conn of GraphState.graph?.connections || []) {
            if (!conn.reroutes || conn.reroutes.length === 0) continue;
            
            for (let i = 0; i < conn.reroutes.length; i++) {
                const rp = conn.reroutes[i];
                
                // Check if reroute point is inside the loop container area
                if (rp.x > loopRect.x && rp.x < loopRect.x + loopRect.width &&
                    rp.y > loopRect.y && rp.y < loopRect.y + loopRect.height) {
                    const key = conn.id + '-' + i;
                    this.containedReroutePoints[key] = {
                        connId: conn.id,
                        index: i,
                        startPos: { x: rp.x, y: rp.y },
                        // Store offset relative to loop position for precise following
                        offsetFromLoop: {
                            x: rp.x - (loopNode.position?.x || 0),
                            y: rp.y - (loopNode.position?.y || 0)
                        }
                    };
                    // Track which loop this reroute belongs to
                    this.rerouteLoopParents[key] = loopNode.id;
                }
            }
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
        
        // Also move contained nodes (for loop containers)
        for (const containedId of Object.keys(this.containedNodePositions)) {
            const startPos = this.containedNodePositions[containedId];
            const node = GraphState.getNode(containedId);
            if (!node || !startPos) continue;
            
            let newX = startPos.x + deltaX;
            let newY = startPos.y + deltaY;
            
            if (GraphState.snapToGrid) {
                newX = GraphState.snapToGridValue(newX);
                newY = GraphState.snapToGridValue(newY);
            }
            
            node.position = { x: newX, y: newY };
            NodeRenderer.updateNodePosition(containedId, node.position);
        }
        
        // Also move contained reroute points (for loop containers)
        // Reroute points maintain their offset relative to the parent loop's position
        for (const key of Object.keys(this.containedReroutePoints)) {
            const rpInfo = this.containedReroutePoints[key];
            const conn = GraphState.getConnection(rpInfo.connId);
            if (!conn || !conn.reroutes || !conn.reroutes[rpInfo.index]) continue;
            
            // Get the parent loop's current position (which includes snapping)
            const loopId = this.rerouteLoopParents[key];
            const loopNode = loopId ? GraphState.getNode(loopId) : null;
            
            if (loopNode && rpInfo.offsetFromLoop) {
                // Position reroute point relative to loop's current (snapped) position
                conn.reroutes[rpInfo.index].x = loopNode.position.x + rpInfo.offsetFromLoop.x;
                conn.reroutes[rpInfo.index].y = loopNode.position.y + rpInfo.offsetFromLoop.y;
            } else {
                // Fallback: use raw delta
                conn.reroutes[rpInfo.index].x = rpInfo.startPos.x + deltaX;
                conn.reroutes[rpInfo.index].y = rpInfo.startPos.y + deltaY;
            }
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
        const oldPositions = { ...this.dragStartPositions, ...this.containedNodePositions };
        const newPositions = {};
        let hasMoved = false;
        
        // Track selected node positions
        for (const nodeId of GraphState.selectedNodeIds) {
            const node = GraphState.getNode(nodeId);
            if (node) {
                newPositions[nodeId] = { ...node.position };
                
                // Check if actually moved
                const oldPos = this.dragStartPositions[nodeId];
                if (oldPos && (oldPos.x !== node.position.x || oldPos.y !== node.position.y)) {
                    hasMoved = true;
                }
            }
        }
        
        // Track contained node positions
        for (const containedId of Object.keys(this.containedNodePositions)) {
            const node = GraphState.getNode(containedId);
            if (node) {
                newPositions[containedId] = { ...node.position };
            }
        }
        
        // Save moved reroute points
        const movedRerouteConnections = new Set();
        for (const key of Object.keys(this.containedReroutePoints)) {
            const rpInfo = this.containedReroutePoints[key];
            movedRerouteConnections.add(rpInfo.connId);
        }
        
        // Notify about reroute point changes
        for (const connId of movedRerouteConnections) {
            const conn = GraphState.getConnection(connId);
            if (conn && conn.reroutes) {
                vscode.postMessage({
                    type: 'updateConnection',
                    payload: { connectionId: connId, reroutes: conn.reroutes }
                });
            }
        }
        
        // Check if dropped nodes are inside any loop container
        this.updateLoopContainment();
        
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
        this.containedNodePositions = {};
        this.containedReroutePoints = {};
        this.rerouteLoopParents = {};
        this.initialMousePos = null;
        
        Minimap.update();
    },
    
    // Check if nodes are inside loop containers and update containment
    updateLoopContainment() {
        const loopNodes = GraphState.graph?.nodes?.filter(n => n.type === 'for_loop') || [];
        const nodesChangedContainment = []; // Track nodes that crossed loop boundaries
        
        for (const loop of loopNodes) {
            const loopEl = document.getElementById('node-' + loop.id);
            if (!loopEl) continue;
            
            const loopRect = {
                x: loop.position?.x || 0,
                y: (loop.position?.y || 0) + 35, // Below title bar
                width: loop.config?.width || 400,
                height: (loop.config?.height || 250) - 35
            };
            
            const containedIds = new Set();
            const oldContainedIds = new Set(
                (loop.config?.containedNodeIds || '').split(',').filter(s => s.trim()).map(s => s.trim())
            );
            
            // Check all non-loop nodes
            for (const node of GraphState.graph?.nodes || []) {
                if (node.id === loop.id) continue;
                if (node.type === 'for_loop' || node.type === 'group' || node.type === 'comment') continue;
                
                const nodeEl = document.getElementById('node-' + node.id);
                if (!nodeEl) continue;
                
                const nodeRect = {
                    x: node.position?.x || 0,
                    y: node.position?.y || 0,
                    width: nodeEl.offsetWidth,
                    height: nodeEl.offsetHeight
                };
                
                // Check if node center is inside loop container area
                const nodeCenterX = nodeRect.x + nodeRect.width / 2;
                const nodeCenterY = nodeRect.y + nodeRect.height / 2;
                
                if (nodeCenterX > loopRect.x && 
                    nodeCenterX < loopRect.x + loopRect.width &&
                    nodeCenterY > loopRect.y && 
                    nodeCenterY < loopRect.y + loopRect.height) {
                    containedIds.add(node.id);
                    
                    // Track if this node just entered the loop
                    if (!oldContainedIds.has(node.id)) {
                        nodesChangedContainment.push({ nodeId: node.id, newLoopId: loop.id, oldLoopId: null });
                    }
                } else {
                    // Track if this node just left the loop
                    if (oldContainedIds.has(node.id)) {
                        nodesChangedContainment.push({ nodeId: node.id, newLoopId: null, oldLoopId: loop.id });
                    }
                }
            }
            
            // Update loop's containedNodeIds
            const newContainedStr = Array.from(containedIds).join(',');
            const oldContainedStr = loop.config?.containedNodeIds || '';
            
            if (newContainedStr !== oldContainedStr) {
                loop.config = loop.config || {};
                loop.config.containedNodeIds = newContainedStr;
                
                vscode.postMessage({
                    type: 'updateNodeConfig',
                    payload: { 
                        nodeId: loop.id, 
                        config: { containedNodeIds: newContainedStr } 
                    }
                });
            }
        }
        
        // Break invalid connections for nodes that crossed loop boundaries
        if (nodesChangedContainment.length > 0) {
            this.breakInvalidLoopConnections(nodesChangedContainment);
        }
    },
    
    // Break connections that cross loop boundaries after nodes are moved
    breakInvalidLoopConnections(changedNodes) {
        const connectionsToDelete = [];
        
        // Check all connections for validity using ConnectionManager's validation
        for (const conn of GraphState.graph?.connections || []) {
            // Check if this connection involves a node that changed containment
            const fromChanged = changedNodes.some(c => c.nodeId === conn.fromNodeId);
            const toChanged = changedNodes.some(c => c.nodeId === conn.toNodeId);
            if (!fromChanged && !toChanged) continue;
            
            // Use shared validation from ConnectionManager
            const loopCheck = ConnectionManager.isLoopConnectionValid(
                conn.fromNodeId, conn.fromPortId, conn.toNodeId, conn.toPortId
            );
            
            if (!loopCheck.valid) {
                connectionsToDelete.push(conn.id);
            }
        }
        
        // Delete invalid connections
        if (connectionsToDelete.length > 0) {
            for (const connId of connectionsToDelete) {
                vscode.postMessage({
                    type: 'deleteConnection',
                    payload: { connectionId: connId }
                });
            }
            
            // Show status message
            const count = connectionsToDelete.length;
            StatusBar.setStatus(count + ' connection' + (count > 1 ? 's' : '') + ' removed (crossed loop boundary)');
            setTimeout(() => StatusBar.setStatus('Ready'), 3000);
        }
    }
};
`;
}

