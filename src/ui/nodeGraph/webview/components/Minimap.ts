// ============================================================================
// Minimap - Overview panel
// ============================================================================

/**
 * Get the Minimap module code for the webview
 */
export function getMinimapCode(): string {
    return `
// ============================================================================
// Minimap - Canvas overview
// ============================================================================

const Minimap = {
    container: null,
    content: null,
    viewport: null,
    isDragging: false,
    
    init() {
        this.container = document.getElementById('minimap');
        if (!this.container) return;
        
        this.content = this.container.querySelector('.minimap-content');
        this.viewport = this.container.querySelector('.minimap-viewport');
        
        if (this.viewport) {
            this.viewport.addEventListener('mousedown', (e) => this.startDrag(e));
            document.addEventListener('mousemove', (e) => this.drag(e));
            document.addEventListener('mouseup', () => this.endDrag());
        }
        
        // Click on minimap to navigate
        this.content?.addEventListener('click', (e) => {
            if (e.target === this.viewport) return;
            this.navigateTo(e);
        });
    },
    
    // Update minimap
    update() {
        if (!this.content || !GraphState.graph) return;
        
        // Get bounds
        const bounds = Canvas.getCanvasBounds();
        const padding = 20;
        const contentWidth = bounds.maxX - bounds.minX + padding * 2;
        const contentHeight = bounds.maxY - bounds.minY + padding * 2;
        
        // Calculate scale
        const minimapWidth = this.container.clientWidth;
        const minimapHeight = this.container.clientHeight;
        const scale = Math.min(
            minimapWidth / contentWidth,
            minimapHeight / contentHeight,
            1
        );
        
        // Clear and render nodes
        this.content.innerHTML = '';
        
        for (const node of GraphState.graph.nodes) {
            const nodeEl = document.createElement('div');
            nodeEl.className = 'minimap-node';
            nodeEl.style.left = ((node.position?.x || 0) - bounds.minX + padding) * scale + 'px';
            nodeEl.style.top = ((node.position?.y || 0) - bounds.minY + padding) * scale + 'px';
            nodeEl.style.width = Math.max(150 * scale, 4) + 'px';
            nodeEl.style.height = Math.max(60 * scale, 3) + 'px';
            
            // Highlight selected nodes
            if (GraphState.selectedNodeIds.has(node.id)) {
                nodeEl.style.background = 'var(--vscode-focusBorder)';
            }
            
            this.content.appendChild(nodeEl);
        }
        
        // Create viewport indicator
        this.viewport = document.createElement('div');
        this.viewport.className = 'minimap-viewport';
        this.content.appendChild(this.viewport);
        
        // Update viewport position
        this.updateViewport(bounds, scale, padding);
        
        // Re-attach drag handlers
        this.viewport.addEventListener('mousedown', (e) => this.startDrag(e));
    },
    
    // Update viewport indicator
    updateViewport(bounds, scale, padding) {
        if (!this.viewport || !Canvas.container) return;
        
        const containerRect = Canvas.container.getBoundingClientRect();
        
        // Calculate visible area in canvas coordinates
        const visibleLeft = -GraphState.panX / GraphState.zoom;
        const visibleTop = -GraphState.panY / GraphState.zoom;
        const visibleWidth = containerRect.width / GraphState.zoom;
        const visibleHeight = containerRect.height / GraphState.zoom;
        
        // Convert to minimap coordinates
        this.viewport.style.left = (visibleLeft - bounds.minX + padding) * scale + 'px';
        this.viewport.style.top = (visibleTop - bounds.minY + padding) * scale + 'px';
        this.viewport.style.width = visibleWidth * scale + 'px';
        this.viewport.style.height = visibleHeight * scale + 'px';
    },
    
    // Start dragging viewport
    startDrag(e) {
        e.stopPropagation();
        this.isDragging = true;
    },
    
    // Drag viewport
    drag(e) {
        if (!this.isDragging) return;
        this.navigateTo(e);
    },
    
    // End dragging
    endDrag() {
        this.isDragging = false;
    },
    
    // Navigate to position
    navigateTo(e) {
        if (!this.content || !Canvas.container) return;
        
        const rect = this.content.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        
        // Get current scale and bounds
        const bounds = Canvas.getCanvasBounds();
        const padding = 20;
        const contentWidth = bounds.maxX - bounds.minX + padding * 2;
        const contentHeight = bounds.maxY - bounds.minY + padding * 2;
        const scale = Math.min(
            this.container.clientWidth / contentWidth,
            this.container.clientHeight / contentHeight,
            1
        );
        
        // Convert click to canvas coordinates
        const canvasX = clickX / scale + bounds.minX - padding;
        const canvasY = clickY / scale + bounds.minY - padding;
        
        // Center view on click position
        const containerRect = Canvas.container.getBoundingClientRect();
        GraphState.panX = containerRect.width / 2 - canvasX * GraphState.zoom;
        GraphState.panY = containerRect.height / 2 - canvasY * GraphState.zoom;
        
        Canvas.updateTransform();
        ConnectionRenderer.updateAllConnections();
        this.update();
    },
    
    // Toggle visibility
    toggle() {
        if (this.container) {
            this.container.classList.toggle('hidden', !GraphState.showMinimap);
        }
    },
    
    // Show/hide
    show() {
        GraphState.showMinimap = true;
        this.container?.classList.remove('hidden');
        this.update();
    },
    
    hide() {
        GraphState.showMinimap = false;
        this.container?.classList.add('hidden');
    }
};
`;
}

