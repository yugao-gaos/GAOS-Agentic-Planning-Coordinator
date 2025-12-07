// ============================================================================
// ValidationPanel - Validation errors display
// ============================================================================

/**
 * Get the ValidationPanel module code for the webview
 */
export function getValidationPanelCode(): string {
    return `
// ============================================================================
// ValidationPanel - Graph validation errors
// ============================================================================

const ValidationPanel = {
    container: null,
    
    init() {
        this.container = document.getElementById('validation-panel');
    },
    
    // Update validation display
    update() {
        if (!this.container) return;
        
        const errors = GraphState.validationErrors;
        
        if (errors.length === 0) {
            this.container.innerHTML = \`
                <div class="validation-header" style="background: var(--vscode-testing-iconPassed);">
                    <span>✓ No validation errors</span>
                    <button onclick="ValidationPanel.hide()" style="background: none; border: none; cursor: pointer; color: inherit;">×</button>
                </div>
            \`;
        } else {
            this.container.innerHTML = \`
                <div class="validation-header">
                    <span>⚠ \${errors.length} validation error\${errors.length > 1 ? 's' : ''}</span>
                    <button onclick="ValidationPanel.hide()" style="background: none; border: none; cursor: pointer; color: inherit;">×</button>
                </div>
                <div class="validation-list">
                    \${errors.map((err, i) => \`
                        <div class="validation-item" data-node-id="\${err.nodeId || ''}" onclick="ValidationPanel.navigateTo(\${i})">
                            <span class="icon">⚠</span>
                            <span>\${err.message}</span>
                        </div>
                    \`).join('')}
                </div>
            \`;
        }
        
        // Update status bar badge
        StatusBar.updateValidation(errors.length);
    },
    
    // Navigate to error
    navigateTo(index) {
        const error = GraphState.validationErrors[index];
        if (!error || !error.nodeId) return;
        
        // Select and center on node
        GraphState.selectNode(error.nodeId, false);
        
        const node = GraphState.getNode(error.nodeId);
        if (node) {
            const rect = Canvas.container.getBoundingClientRect();
            GraphState.panX = rect.width / 2 - (node.position?.x || 0) * GraphState.zoom - 75;
            GraphState.panY = rect.height / 2 - (node.position?.y || 0) * GraphState.zoom - 40;
            
            Canvas.updateTransform();
            ConnectionRenderer.updateAllConnections();
            Minimap.update();
        }
    },
    
    // Toggle visibility
    toggle() {
        if (this.container) {
            this.container.classList.toggle('hidden', !GraphState.showValidation);
            if (GraphState.showValidation) {
                GraphState.validate();
                this.update();
            }
        }
    },
    
    // Show panel
    show() {
        GraphState.showValidation = true;
        this.container?.classList.remove('hidden');
        GraphState.validate();
        this.update();
    },
    
    // Hide panel
    hide() {
        GraphState.showValidation = false;
        this.container?.classList.add('hidden');
    }
};

// Update validation when graph changes
GraphState.on('validationChanged', () => {
    if (GraphState.showValidation) {
        ValidationPanel.update();
    }
    StatusBar.updateValidation(GraphState.validationErrors.length);
});
`;
}

