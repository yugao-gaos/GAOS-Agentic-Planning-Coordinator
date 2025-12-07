// ============================================================================
// SelectionManager - Multi-select, box select
// ============================================================================

/**
 * Get the SelectionManager module code for the webview
 */
export function getSelectionManagerCode(): string {
    return `
// ============================================================================
// SelectionManager - Selection handling (integrated into GraphState)
// ============================================================================

// Selection is primarily handled by GraphState
// This module provides additional selection utilities

const SelectionManager = {
    // Get bounding box of selected nodes
    getSelectionBounds() {
        const nodes = GraphState.getSelectedNodes();
        if (nodes.length === 0) return null;
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        for (const node of nodes) {
            const x = node.position?.x || 0;
            const y = node.position?.y || 0;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + 150);
            maxY = Math.max(maxY, y + 80);
        }
        
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    },
    
    // Center view on selection
    centerOnSelection() {
        const bounds = this.getSelectionBounds();
        if (!bounds) return;
        
        const rect = Canvas.container.getBoundingClientRect();
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        
        GraphState.panX = rect.width / 2 - centerX * GraphState.zoom;
        GraphState.panY = rect.height / 2 - centerY * GraphState.zoom;
        
        Canvas.updateTransform();
        ConnectionRenderer.updateAllConnections();
        Minimap.update();
    },
    
    // Fit view to selection
    fitToSelection() {
        const nodes = GraphState.getSelectedNodes();
        if (nodes.length === 0) {
            Canvas.fitToView();
        } else {
            Canvas.fitToView(nodes.map(n => n.id));
        }
    }
};
`;
}

