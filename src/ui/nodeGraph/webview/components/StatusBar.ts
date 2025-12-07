// ============================================================================
// StatusBar - Status bar at bottom
// ============================================================================

/**
 * Get the StatusBar module code for the webview
 */
export function getStatusBarCode(): string {
    return `
// ============================================================================
// StatusBar - Editor status bar
// ============================================================================

const StatusBar = {
    container: null,
    statusText: null,
    nodeCount: null,
    connectionCount: null,
    selectionCount: null,
    validationBadge: null,
    
    init() {
        this.container = document.getElementById('status-bar');
        this.statusText = document.getElementById('status-text');
        this.nodeCount = document.getElementById('node-count');
        this.connectionCount = document.getElementById('connection-count');
        this.selectionCount = document.getElementById('selection-count');
        this.validationBadge = document.getElementById('validation-badge');
        
        this.update();
    },
    
    // Update all status bar elements
    update() {
        this.updateCounts();
    },
    
    // Update node/connection counts
    updateCounts() {
        const nodeCount = GraphState.graph?.nodes?.length || 0;
        const connCount = GraphState.graph?.connections?.length || 0;
        const selCount = GraphState.selectedNodeIds.size;
        
        if (this.nodeCount) {
            this.nodeCount.textContent = 'Nodes: ' + nodeCount;
        }
        
        if (this.connectionCount) {
            this.connectionCount.textContent = 'Connections: ' + connCount;
        }
        
        if (this.selectionCount) {
            this.selectionCount.textContent = selCount > 0 ? 'Selected: ' + selCount : '';
        }
    },
    
    // Update validation badge
    updateValidation(errorCount) {
        if (this.validationBadge) {
            if (errorCount > 0) {
                this.validationBadge.textContent = errorCount;
                this.validationBadge.style.display = 'inline-block';
            } else {
                this.validationBadge.style.display = 'none';
            }
        }
    },
    
    // Set status message
    setStatus(message) {
        if (this.statusText) {
            this.statusText.textContent = message;
        }
    }
};

// Update on selection change
GraphState.on('selectionChanged', () => {
    StatusBar.updateCounts();
});
`;
}

