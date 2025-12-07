// ============================================================================
// Toolbar - Toolbar buttons and state
// ============================================================================

/**
 * Get the Toolbar module code for the webview
 */
export function getToolbarCode(): string {
    return `
// ============================================================================
// Toolbar - Editor toolbar
// ============================================================================

const Toolbar = {
    init() {
        this.setupEventListeners();
        this.updateZoomDisplay();
    },
    
    setupEventListeners() {
        // Save buttons
        document.getElementById('btn-save')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'save' });
        });
        
        document.getElementById('btn-save-as')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'saveAs' });
        });
        
        // Undo/Redo
        document.getElementById('btn-undo')?.addEventListener('click', () => {
            UndoManager.undo();
            vscode.postMessage({ type: 'undo' });
        });
        
        document.getElementById('btn-redo')?.addEventListener('click', () => {
            UndoManager.redo();
            vscode.postMessage({ type: 'redo' });
        });
        
        // View controls
        document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
            Canvas.fitToView();
        });
        
        document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
            Canvas.setZoom(1);
        });
        
        // Zoom slider
        document.getElementById('zoom-slider')?.addEventListener('input', (e) => {
            Canvas.setZoom(parseFloat(e.target.value));
        });
        
        // Grid snap toggle
        document.getElementById('btn-grid-snap')?.addEventListener('click', (e) => {
            GraphState.snapToGrid = !GraphState.snapToGrid;
            e.target.classList.toggle('active', GraphState.snapToGrid);
        });
        
        // Minimap toggle
        document.getElementById('btn-minimap')?.addEventListener('click', (e) => {
            GraphState.showMinimap = !GraphState.showMinimap;
            e.target.classList.toggle('active', GraphState.showMinimap);
            Minimap.toggle();
        });
        
        // Validation toggle
        document.getElementById('btn-validation')?.addEventListener('click', (e) => {
            GraphState.showValidation = !GraphState.showValidation;
            e.target.classList.toggle('active', GraphState.showValidation);
            ValidationPanel.toggle();
        });
        
        // View mode toggle buttons
        document.getElementById('btn-view-exec')?.addEventListener('click', () => this.setViewMode('execution'));
        document.getElementById('btn-view-data')?.addEventListener('click', () => this.setViewMode('data'));
        document.getElementById('btn-view-all')?.addEventListener('click', () => this.setViewMode('all'));
        
        // Graph name input
        document.getElementById('graph-name')?.addEventListener('change', (e) => {
            if (GraphState.graph) {
                GraphState.graph.name = e.target.value;
                vscode.postMessage({
                    type: 'updateGraphMeta',
                    payload: { name: e.target.value }
                });
            }
        });
    },
    
    // Update zoom display
    updateZoomDisplay() {
        const display = document.getElementById('zoom-display');
        const slider = document.getElementById('zoom-slider');
        
        if (display) {
            display.textContent = Math.round(GraphState.zoom * 100) + '%';
        }
        if (slider) {
            slider.value = GraphState.zoom;
        }
    },
    
    // Set view mode: 'execution', 'data', or 'all'
    setViewMode(mode) {
        GraphState.viewMode = mode;
        
        // Update button states
        document.getElementById('btn-view-exec')?.classList.toggle('active', mode === 'execution');
        document.getElementById('btn-view-data')?.classList.toggle('active', mode === 'data');
        document.getElementById('btn-view-all')?.classList.toggle('active', mode === 'all');
        
        // Update canvas class for CSS-based filtering
        const container = document.getElementById('canvas-container');
        if (container) {
            container.classList.remove('view-mode-execution', 'view-mode-data', 'view-mode-all');
            container.classList.add('view-mode-' + mode);
        }
        
        // Re-render connections with appropriate styling
        ConnectionRenderer.updateAllConnections();
    }
};
`;
}

