// ============================================================================
// ConnectionManager - Connection drawing, validation
// ============================================================================

/**
 * Get the ConnectionManager module code for the webview
 */
export function getConnectionManagerCode(): string {
    return `
// ============================================================================
// ConnectionManager - Connection drawing and validation
// ============================================================================

const ConnectionManager = {
    startNodeId: null,
    startPortId: null,
    startPortType: null,
    
    // Start drawing a connection
    startConnection(nodeId, portId, dataType) {
        // Check if port is interactable based on view mode
        if (!this.isPortInteractable(dataType)) return;
        
        GraphState.isConnecting = true;
        this.startNodeId = nodeId;
        this.startPortId = portId;
        this.startPortType = dataType || 'any';
        
        // Create temp line
        ConnectionRenderer.createTempLine();
        
        // Highlight compatible ports
        this.highlightCompatiblePorts(dataType);
    },
    
    // Handle connection drag
    handleConnectionDrag(e) {
        if (!GraphState.isConnecting) return;
        
        const startPort = document.querySelector(
            '[data-node="' + this.startNodeId + '"][data-port="' + this.startPortId + '"]'
        );
        if (!startPort) return;
        
        // Get node element and position
        const startNodeEl = document.getElementById('node-' + this.startNodeId);
        if (!startNodeEl) return;
        
        const startPortRect = startPort.getBoundingClientRect();
        const startNodeRect = startNodeEl.getBoundingClientRect();
        
        // Get node position from style (canvas coordinates)
        const nodeX = parseFloat(startNodeEl.style.left) || 0;
        const nodeY = parseFloat(startNodeEl.style.top) || 0;
        
        // Calculate port offset within node
        const portOffsetX = (startPortRect.left - startNodeRect.left + startPortRect.width/2) / GraphState.zoom;
        const portOffsetY = (startPortRect.top - startNodeRect.top + startPortRect.height/2) / GraphState.zoom;
        
        const x1 = nodeX + portOffsetX;
        const y1 = nodeY + portOffsetY;
        
        const pos = Canvas.screenToCanvas(e.clientX, e.clientY);
        
        ConnectionRenderer.updateTempLine(x1, y1, pos.x, pos.y, this.startPortType);
    },
    
    // Check if a port is interactable based on current view mode
    isPortInteractable(dataType) {
        const viewMode = GraphState.viewMode;
        if (viewMode === 'all') return true;
        
        const isExecutionType = dataType === 'trigger' || dataType === 'agent';
        const isDataType = !isExecutionType;
        
        if (viewMode === 'execution') {
            return isExecutionType;
        }
        if (viewMode === 'data') {
            return isDataType;
        }
        return true;
    },
    
    // End connection drawing
    endConnection(e) {
        if (!GraphState.isConnecting) return;
        
        // Check if we dropped on an input port
        const targetPort = e.target.closest('.port-dot[data-direction="input"]');
        
        if (targetPort) {
            const toNodeId = targetPort.dataset.node;
            const toPortId = targetPort.dataset.port;
            const toPortType = targetPort.dataset.type || 'any';
            
            // Check if target port is interactable based on view mode
            if (!this.isPortInteractable(toPortType)) {
                ConnectionRenderer.removeTempLine();
                this.clearPortHighlights();
                GraphState.isConnecting = false;
                this.startNodeId = null;
                this.startPortId = null;
                this.startPortType = null;
                return;
            }
            
            // Validate connection
            if (toNodeId !== this.startNodeId) {
                if (this.areTypesCompatible(this.startPortType, toPortType)) {
                    // Check if connection already exists
                    const exists = GraphState.graph?.connections?.some(c =>
                        c.fromNodeId === this.startNodeId &&
                        c.fromPortId === this.startPortId &&
                        c.toNodeId === toNodeId &&
                        c.toPortId === toPortId
                    );
                    
                    if (exists) {
                        // Connection already exists
                        StatusBar.setStatus('Connection already exists');
                        setTimeout(() => StatusBar.setStatus('Ready'), 2000);
                    } else if (this.startPortType === 'trigger') {
                        // Trigger ports are 1:1 - check for existing connections
                        const fromHasConnection = GraphState.graph?.connections?.some(c =>
                            c.fromNodeId === this.startNodeId &&
                            c.fromPortId === this.startPortId
                        );
                        const toHasConnection = GraphState.graph?.connections?.some(c =>
                            c.toNodeId === toNodeId &&
                            c.toPortId === toPortId
                        );
                        
                        if (fromHasConnection) {
                            StatusBar.setStatus('Execution output already connected (1:1 only)');
                            setTimeout(() => StatusBar.setStatus('Ready'), 2000);
                        } else if (toHasConnection) {
                            StatusBar.setStatus('Execution input already connected (1:1 only)');
                            setTimeout(() => StatusBar.setStatus('Ready'), 2000);
                        } else {
                            vscode.postMessage({
                                type: 'addConnection',
                                payload: {
                                    fromNodeId: this.startNodeId,
                                    fromPortId: this.startPortId,
                                    toNodeId,
                                    toPortId
                                }
                            });
                        }
                    } else if (this.startPortType === 'agent') {
                        // Agent ports check allowMultiple attribute
                        const sourcePort = document.querySelector(
                            '[data-node="' + this.startNodeId + '"][data-port="' + this.startPortId + '"]'
                        );
                        const sourceAllowMultiple = sourcePort?.dataset?.allowMultiple === 'true';
                        const targetAllowMultiple = targetPort?.dataset?.allowMultiple === 'true';
                        
                        const fromHasConnection = GraphState.graph?.connections?.some(c =>
                            c.fromNodeId === this.startNodeId &&
                            c.fromPortId === this.startPortId
                        );
                        const toHasConnection = GraphState.graph?.connections?.some(c =>
                            c.toNodeId === toNodeId &&
                            c.toPortId === toPortId
                        );
                        
                        if (!sourceAllowMultiple && fromHasConnection) {
                            StatusBar.setStatus('Agent output already connected (single connection only)');
                            setTimeout(() => StatusBar.setStatus('Ready'), 2000);
                        } else if (!targetAllowMultiple && toHasConnection) {
                            StatusBar.setStatus('Agent input already connected (single connection only)');
                            setTimeout(() => StatusBar.setStatus('Ready'), 2000);
                        } else {
                            vscode.postMessage({
                                type: 'addConnection',
                                payload: {
                                    fromNodeId: this.startNodeId,
                                    fromPortId: this.startPortId,
                                    toNodeId,
                                    toPortId
                                }
                            });
                        }
                    } else {
                        // Data connections allow multiple
                        vscode.postMessage({
                            type: 'addConnection',
                            payload: {
                                fromNodeId: this.startNodeId,
                                fromPortId: this.startPortId,
                                toNodeId,
                                toPortId
                            }
                        });
                    }
                } else {
                    // Show incompatible type message
                    StatusBar.setStatus('Incompatible port types: ' + this.startPortType + ' → ' + toPortType);
                    setTimeout(() => StatusBar.setStatus('Ready'), 2000);
                }
            }
        }
        
        // Cleanup
        ConnectionRenderer.removeTempLine();
        this.clearPortHighlights();
        
        GraphState.isConnecting = false;
        this.startNodeId = null;
        this.startPortId = null;
        this.startPortType = null;
    },
    
    // Check if port types are compatible
    areTypesCompatible(sourceType, targetType) {
        // Trigger/execution ports ONLY connect to other trigger ports
        // Check this FIRST before any other compatibility rules
        if (sourceType === 'trigger' || targetType === 'trigger') {
            return sourceType === 'trigger' && targetType === 'trigger';
        }
        
        // 'any' is compatible with all DATA types (trigger already handled above)
        if (sourceType === 'any' || targetType === 'any') {
            return true;
        }
        
        // Direct type match
        if (sourceType === targetType) {
            return true;
        }
        
        // Number/string/boolean can convert to each other
        const primitives = ['string', 'number', 'boolean'];
        if (primitives.includes(sourceType) && primitives.includes(targetType)) {
            return true;
        }
        
        // Object/array are compatible
        if ((sourceType === 'object' || sourceType === 'array') && 
            (targetType === 'object' || targetType === 'array')) {
            return true;
        }
        
        return false;
    },
    
    // Highlight compatible ports
    highlightCompatiblePorts(sourceType) {
        // For trigger types, check if source already has a connection
        let sourceAlreadyConnected = false;
        let sourceAllowMultiple = false;
        
        if (sourceType === 'trigger') {
            sourceAlreadyConnected = GraphState.graph?.connections?.some(c =>
                c.fromNodeId === this.startNodeId &&
                c.fromPortId === this.startPortId
            );
        } else if (sourceType === 'agent') {
            const sourcePort = document.querySelector(
                '[data-node="' + this.startNodeId + '"][data-port="' + this.startPortId + '"]'
            );
            sourceAllowMultiple = sourcePort?.dataset?.allowMultiple === 'true';
            if (!sourceAllowMultiple) {
                sourceAlreadyConnected = GraphState.graph?.connections?.some(c =>
                    c.fromNodeId === this.startNodeId &&
                    c.fromPortId === this.startPortId
                );
            }
        }
        
        document.querySelectorAll('.port-dot[data-direction="input"]').forEach(port => {
            const portType = port.dataset.type || 'any';
            const nodeId = port.dataset.node;
            const portId = port.dataset.port;
            const targetAllowMultiple = port.dataset.allowMultiple === 'true';
            
            // Check if port is interactable based on view mode
            if (!this.isPortInteractable(portType)) {
                return; // Skip greyed out ports
            }
            
            if (!this.areTypesCompatible(sourceType, portType)) {
                port.classList.add('incompatible');
                return;
            }
            
            // For trigger connections, check 1:1 constraint
            if (sourceType === 'trigger') {
                if (sourceAlreadyConnected) {
                    port.classList.add('incompatible');
                    return;
                }
                
                // Check if target input already has a trigger connection
                const targetHasConnection = GraphState.graph?.connections?.some(c =>
                    c.toNodeId === nodeId &&
                    c.toPortId === portId
                );
                
                if (targetHasConnection) {
                    port.classList.add('incompatible');
                    return;
                }
            }
            
            // For agent connections, check allowMultiple constraint
            if (sourceType === 'agent') {
                if (!sourceAllowMultiple && sourceAlreadyConnected) {
                    port.classList.add('incompatible');
                    return;
                }
                
                if (!targetAllowMultiple) {
                    const targetHasConnection = GraphState.graph?.connections?.some(c =>
                        c.toNodeId === nodeId &&
                        c.toPortId === portId
                    );
                    
                    if (targetHasConnection) {
                        port.classList.add('incompatible');
                        return;
                    }
                }
            }
            
            port.classList.add('compatible');
        });
    },
    
    // Preview compatible ports on hover (before drag)
    previewCompatiblePorts(sourceType) {
        // Check if source port is interactable
        if (!this.isPortInteractable(sourceType)) return;
        
        document.querySelectorAll('.port-dot[data-direction="input"]').forEach(port => {
            const portType = port.dataset.type || 'any';
            
            // Check if target port is interactable
            if (!this.isPortInteractable(portType)) return;
            
            if (this.areTypesCompatible(sourceType, portType)) {
                port.classList.add('compatible');
            }
        });
    },
    
    // Clear port highlights
    clearPortHighlights() {
        document.querySelectorAll('.port-dot').forEach(port => {
            port.classList.remove('compatible', 'incompatible');
        });
    }
};
`;
}

