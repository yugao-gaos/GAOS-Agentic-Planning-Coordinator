// ============================================================================
// Canvas - Pan, zoom, grid, selection box rendering
// ============================================================================

/**
 * Get the Canvas module code for the webview
 */
export function getCanvasCode(): string {
    return `
// ============================================================================
// Canvas - Pan, zoom, grid, and selection box
// ============================================================================

const Canvas = {
    container: null,
    nodesLayer: null,
    connectionsSvg: null,
    selectionBox: null,
    
    init() {
        this.container = document.getElementById('canvas-container');
        this.nodesLayer = document.getElementById('nodes-layer');
        this.connectionsSvg = document.getElementById('connections-svg');
        
        this.setupEventListeners();
    },
    
    setupEventListeners() {
        // Wheel zoom
        this.container.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
        
        // Pan and box selection
        this.container.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.container.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.container.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.container.addEventListener('mouseleave', (e) => this.handleMouseUp(e));
        
        // Drag and drop from palette - add to both container and nodes layer
        const setupDrop = (el) => {
            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            });
            el.addEventListener('drop', (e) => this.handleDrop(e));
        };
        setupDrop(this.container);
        setupDrop(this.nodesLayer);
        
        // Double-click to reset view or enter subgraph
        this.container.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
        
        // Context menu
        this.container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const pos = this.screenToCanvas(e.clientX, e.clientY);
            ContextMenu.showCanvasMenu(e.clientX, e.clientY, pos);
        });
    },
    
    handleWheel(e) {
        e.preventDefault();
        
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newZoom = Math.max(0.25, Math.min(2, GraphState.zoom + delta));
        
        // Zoom towards mouse position
        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const zoomRatio = newZoom / GraphState.zoom;
        GraphState.panX = mouseX - (mouseX - GraphState.panX) * zoomRatio;
        GraphState.panY = mouseY - (mouseY - GraphState.panY) * zoomRatio;
        GraphState.zoom = newZoom;
        
        this.updateTransform();
        ConnectionRenderer.updateAllConnections();
        Minimap.update();
        Toolbar.updateZoomDisplay();
    },
    
    handleMouseDown(e) {
        // Only handle clicks on the canvas itself, not on nodes
        if (e.target !== this.container && !e.target.classList.contains('nodes-layer')) {
            return;
        }
        
        // Right click is handled by context menu
        if (e.button === 2) return;
        
        // Middle mouse or Shift+Left for panning
        if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
            GraphState.isPanning = true;
            GraphState.dragOffset = {
                x: e.clientX - GraphState.panX,
                y: e.clientY - GraphState.panY
            };
            this.container.style.cursor = 'grabbing';
            e.preventDefault();
            return;
        }
        
        // Left click - start box selection or clear selection
        if (e.button === 0) {
            const pos = this.screenToCanvas(e.clientX, e.clientY);
            
            if (!e.ctrlKey && !e.metaKey) {
                GraphState.clearSelection();
            }
            
            // Start box selection
            GraphState.isBoxSelecting = true;
            GraphState.boxSelectStart = pos;
            
            // Create selection box element
            this.selectionBox = document.createElement('div');
            this.selectionBox.className = 'selection-box';
            this.container.appendChild(this.selectionBox);
        }
    },
    
    handleMouseMove(e) {
        // Track mouse position
        GraphState.lastMousePos = { x: e.clientX, y: e.clientY };
        
        // Panning
        if (GraphState.isPanning) {
            GraphState.panX = e.clientX - GraphState.dragOffset.x;
            GraphState.panY = e.clientY - GraphState.dragOffset.y;
            this.updateTransform();
            ConnectionRenderer.updateAllConnections();
            Minimap.update();
            return;
        }
        
        // Box selection
        if (GraphState.isBoxSelecting && this.selectionBox && GraphState.boxSelectStart) {
            const currentPos = this.screenToCanvas(e.clientX, e.clientY);
            const startPos = GraphState.boxSelectStart;
            
            const rect = {
                x: Math.min(startPos.x, currentPos.x),
                y: Math.min(startPos.y, currentPos.y),
                width: Math.abs(currentPos.x - startPos.x),
                height: Math.abs(currentPos.y - startPos.y)
            };
            
            // Update visual selection box (in screen coordinates)
            const screenStart = this.canvasToScreen(startPos.x, startPos.y);
            const screenCurrent = this.canvasToScreen(currentPos.x, currentPos.y);
            
            this.selectionBox.style.left = Math.min(screenStart.x, screenCurrent.x) + 'px';
            this.selectionBox.style.top = Math.min(screenStart.y, screenCurrent.y) + 'px';
            this.selectionBox.style.width = Math.abs(screenCurrent.x - screenStart.x) + 'px';
            this.selectionBox.style.height = Math.abs(screenCurrent.y - screenStart.y) + 'px';
            
            // Update selection
            GraphState.selectNodesInRect(rect);
        }
        
        // Node dragging is handled by DragManager
        if (GraphState.isDragging) {
            DragManager.handleDrag(e);
        }
        
        // Connection drawing is handled by ConnectionManager
        if (GraphState.isConnecting) {
            ConnectionManager.handleConnectionDrag(e);
        }
    },
    
    handleMouseUp(e) {
        // End panning
        if (GraphState.isPanning) {
            GraphState.isPanning = false;
            this.container.style.cursor = '';
        }
        
        // End box selection
        if (GraphState.isBoxSelecting) {
            GraphState.isBoxSelecting = false;
            GraphState.boxSelectStart = null;
            if (this.selectionBox) {
                this.selectionBox.remove();
                this.selectionBox = null;
            }
        }
        
        // End node dragging
        if (GraphState.isDragging) {
            DragManager.endDrag(e);
        }
        
        // End connection drawing
        if (GraphState.isConnecting) {
            ConnectionManager.endConnection(e);
        }
    },
    
    handleDrop(e) {
        e.preventDefault();
        const nodeType = e.dataTransfer.getData('nodeType');
        if (!nodeType) return;
        
        const pos = this.screenToCanvas(e.clientX, e.clientY);
        const snappedPos = {
            x: GraphState.snapToGridValue(pos.x),
            y: GraphState.snapToGridValue(pos.y)
        };
        
        vscode.postMessage({
            type: 'addNode',
            payload: { type: nodeType, position: snappedPos }
        });
    },
    
    handleDoubleClick(e) {
        // If clicking on empty canvas, fit to view
        if (e.target === this.container || e.target.classList.contains('nodes-layer')) {
            this.fitToView();
        }
    },
    
    // Coordinate conversions
    screenToCanvas(screenX, screenY) {
        const rect = this.container.getBoundingClientRect();
        return {
            x: (screenX - rect.left - GraphState.panX) / GraphState.zoom,
            y: (screenY - rect.top - GraphState.panY) / GraphState.zoom
        };
    },
    
    canvasToScreen(canvasX, canvasY) {
        const rect = this.container.getBoundingClientRect();
        return {
            x: canvasX * GraphState.zoom + GraphState.panX,
            y: canvasY * GraphState.zoom + GraphState.panY
        };
    },
    
    // Update canvas transform
    updateTransform() {
        const transform = \`translate(\${GraphState.panX}px, \${GraphState.panY}px) scale(\${GraphState.zoom})\`;
        this.nodesLayer.style.transform = transform;
        this.connectionsSvg.style.transform = transform;
    },
    
    // Fit all nodes in view
    fitToView(nodeIds = null) {
        if (!GraphState.graph || GraphState.graph.nodes.length === 0) return;
        
        const nodes = nodeIds 
            ? GraphState.graph.nodes.filter(n => nodeIds.includes(n.id))
            : GraphState.graph.nodes;
        
        if (nodes.length === 0) return;
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        for (const node of nodes) {
            const x = node.position?.x || 0;
            const y = node.position?.y || 0;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + 150);
            maxY = Math.max(maxY, y + 100);
        }
        
        const rect = this.container.getBoundingClientRect();
        const contentWidth = maxX - minX + 100;
        const contentHeight = maxY - minY + 100;
        
        GraphState.zoom = Math.min(
            rect.width / contentWidth,
            rect.height / contentHeight,
            1
        );
        GraphState.panX = (rect.width - contentWidth * GraphState.zoom) / 2 - minX * GraphState.zoom;
        GraphState.panY = (rect.height - contentHeight * GraphState.zoom) / 2 - minY * GraphState.zoom;
        
        this.updateTransform();
        ConnectionRenderer.updateAllConnections();
        Minimap.update();
        Toolbar.updateZoomDisplay();
    },
    
    // Reset view
    resetView() {
        GraphState.zoom = 1;
        GraphState.panX = 0;
        GraphState.panY = 0;
        
        this.updateTransform();
        ConnectionRenderer.updateAllConnections();
        Minimap.update();
        Toolbar.updateZoomDisplay();
    },
    
    // Set zoom level
    setZoom(zoom) {
        const rect = this.container.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        const zoomRatio = zoom / GraphState.zoom;
        GraphState.panX = centerX - (centerX - GraphState.panX) * zoomRatio;
        GraphState.panY = centerY - (centerY - GraphState.panY) * zoomRatio;
        GraphState.zoom = zoom;
        
        this.updateTransform();
        ConnectionRenderer.updateAllConnections();
        Minimap.update();
        Toolbar.updateZoomDisplay();
    },
    
    // Get canvas bounds
    getCanvasBounds() {
        if (!GraphState.graph || GraphState.graph.nodes.length === 0) {
            return { minX: 0, minY: 0, maxX: 500, maxY: 500 };
        }
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        for (const node of GraphState.graph.nodes) {
            const x = node.position?.x || 0;
            const y = node.position?.y || 0;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + 150);
            maxY = Math.max(maxY, y + 100);
        }
        
        return { minX, minY, maxX, maxY };
    }
};
`;
}

