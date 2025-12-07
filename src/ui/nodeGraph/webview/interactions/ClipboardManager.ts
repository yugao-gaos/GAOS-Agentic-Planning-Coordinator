// ============================================================================
// ClipboardManager - Copy/paste/duplicate
// ============================================================================

/**
 * Get the ClipboardManager module code for the webview
 */
export function getClipboardManagerCode(): string {
    return `
// ============================================================================
// ClipboardManager - Copy, paste, duplicate
// ============================================================================

const ClipboardManager = {
    // Copy selected nodes
    copy() {
        if (GraphState.selectedNodeIds.size === 0) return;
        
        const clipboard = GraphState.copySelection();
        if (clipboard) {
            StatusBar.setStatus('Copied ' + clipboard.nodes.length + ' node(s)');
            setTimeout(() => StatusBar.setStatus('Ready'), 1500);
        }
    },
    
    // Cut selected nodes
    cut() {
        if (GraphState.selectedNodeIds.size === 0) return;
        
        const clipboard = GraphState.copySelection();
        if (clipboard) {
            // Delete selected nodes
            const nodeIds = Array.from(GraphState.selectedNodeIds).filter(id => {
                const node = GraphState.getNode(id);
                return node && node.type !== 'start';
            });
            
            if (nodeIds.length > 0) {
                vscode.postMessage({
                    type: 'deleteNodes',
                    payload: { nodeIds }
                });
                
                StatusBar.setStatus('Cut ' + nodeIds.length + ' node(s)');
                setTimeout(() => StatusBar.setStatus('Ready'), 1500);
            }
        }
    },
    
    // Paste nodes
    paste(position) {
        const clipboard = GraphState.getClipboard();
        if (!clipboard || clipboard.nodes.length === 0) return;
        
        // Calculate paste position
        let pasteX, pasteY;
        
        if (position) {
            pasteX = position.x;
            pasteY = position.y;
        } else if (GraphState.lastMousePos) {
            const pos = Canvas.screenToCanvas(GraphState.lastMousePos.x, GraphState.lastMousePos.y);
            pasteX = pos.x;
            pasteY = pos.y;
        } else {
            // Paste at canvas center
            const rect = Canvas.container.getBoundingClientRect();
            pasteX = (rect.width / 2 - GraphState.panX) / GraphState.zoom;
            pasteY = (rect.height / 2 - GraphState.panY) / GraphState.zoom;
        }
        
        // Calculate offset from first node position
        const firstNode = clipboard.nodes[0];
        const offsetX = pasteX - (firstNode.position?.x || 0);
        const offsetY = pasteY - (firstNode.position?.y || 0);
        
        // Generate new IDs and apply offset
        const idMap = {};
        const newNodes = clipboard.nodes.map(node => {
            const newId = 'node_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            idMap[node.id] = newId;
            
            return {
                ...node,
                id: newId,
                position: {
                    x: GraphState.snapToGridValue((node.position?.x || 0) + offsetX),
                    y: GraphState.snapToGridValue((node.position?.y || 0) + offsetY)
                }
            };
        });
        
        // Update connection IDs
        const newConnections = clipboard.connections.map(conn => {
            return {
                ...conn,
                id: 'conn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                fromNodeId: idMap[conn.fromNodeId] || conn.fromNodeId,
                toNodeId: idMap[conn.toNodeId] || conn.toNodeId
            };
        }).filter(conn => idMap[conn.fromNodeId] && idMap[conn.toNodeId]);
        
        // Send paste command to extension
        vscode.postMessage({
            type: 'pasteNodes',
            payload: {
                nodes: newNodes,
                connections: newConnections
            }
        });
        
        StatusBar.setStatus('Pasted ' + newNodes.length + ' node(s)');
        setTimeout(() => StatusBar.setStatus('Ready'), 1500);
    },
    
    // Duplicate selected nodes
    duplicate() {
        if (GraphState.selectedNodeIds.size === 0) return;
        
        // Copy first
        GraphState.copySelection();
        
        // Then paste with offset
        const clipboard = GraphState.getClipboard();
        if (!clipboard || clipboard.nodes.length === 0) return;
        
        // Calculate offset (20px right and down)
        const firstNode = clipboard.nodes[0];
        const pasteX = (firstNode.position?.x || 0) + 20;
        const pasteY = (firstNode.position?.y || 0) + 20;
        
        this.paste({ x: pasteX, y: pasteY });
    }
};
`;
}

