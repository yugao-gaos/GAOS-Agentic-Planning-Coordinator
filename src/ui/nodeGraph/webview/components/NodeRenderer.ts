// ============================================================================
// NodeRenderer - Node DOM creation and updates
// ============================================================================

/**
 * Get the NodeRenderer module code for the webview
 */
export function getNodeRendererCode(): string {
    return `
// ============================================================================
// NodeRenderer - Node rendering and DOM management
// ============================================================================

const NodeRenderer = {
    nodesLayer: null,
    
    init() {
        this.nodesLayer = document.getElementById('nodes-layer');
    },
    
    // Render all nodes
    renderAll() {
        this.nodesLayer.innerHTML = '';
        if (GraphState.graph && GraphState.graph.nodes) {
            for (const node of GraphState.graph.nodes) {
                this.renderNode(node);
            }
        }
    },
    
    // Render a single node
    renderNode(node) {
        // Special rendering for annotation nodes
        if (node.type === 'comment') {
            this.renderCommentNode(node);
            return;
        }
        if (node.type === 'group') {
            this.renderGroupNode(node);
            return;
        }
        if (node.type === 'for_loop') {
            this.renderLoopNode(node);
            return;
        }
        
        const nodeDef = this.getNodeDefinition(node.type);
        
        const nodeEl = document.createElement('div');
        nodeEl.className = 'node';
        nodeEl.id = 'node-' + node.id;
        nodeEl.dataset.nodeId = node.id;
        nodeEl.style.left = (node.position?.x || 0) + 'px';
        nodeEl.style.top = (node.position?.y || 0) + 'px';
        
        if (GraphState.selectedNodeIds.has(node.id)) {
            nodeEl.classList.add('selected');
        }
        
        // Header
        const headerEl = document.createElement('div');
        headerEl.className = 'node-header';
        if (nodeDef?.color) {
            headerEl.style.background = nodeDef.color;
        }
        
        // Get display name: prioritize config.label, then node.label, then definition name
        const displayName = node.config?.label || node.label || nodeDef?.name || node.type;
        
        headerEl.innerHTML = \`
            <span class="node-header-icon">\${this.getNodeIcon(nodeDef)}</span>
            <span class="node-header-title">\${displayName}</span>
            <span class="node-lock-btn \${node.locked ? 'locked' : ''}" title="\${node.locked ? 'Unlock position' : 'Lock position'}">
                \${node.locked ? this.getLockIcon(true) : this.getLockIcon(false)}
            </span>
        \`;
        
        // Lock button click handler
        const lockBtn = headerEl.querySelector('.node-lock-btn');
        if (lockBtn) {
            lockBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                node.locked = !node.locked;
                lockBtn.classList.toggle('locked', node.locked);
                lockBtn.innerHTML = node.locked ? this.getLockIcon(true) : this.getLockIcon(false);
                lockBtn.title = node.locked ? 'Unlock position' : 'Lock position';
                vscode.postMessage({
                    type: 'updateNodeLocked',
                    payload: { nodeId: node.id, locked: node.locked }
                });
            });
        }
        
        nodeEl.appendChild(headerEl);
        
        // Body with ports
        const bodyEl = document.createElement('div');
        bodyEl.className = 'node-body';
        
        // Input ports
        for (const port of node.inputs || []) {
            const portEl = this.createPortElement(node.id, port, 'input');
            bodyEl.appendChild(portEl);
        }
        
        // Output ports
        for (const port of node.outputs || []) {
            const portEl = this.createPortElement(node.id, port, 'output');
            bodyEl.appendChild(portEl);
        }
        
        nodeEl.appendChild(bodyEl);
        this.nodesLayer.appendChild(nodeEl);
        
        // Setup node events
        this.setupNodeEvents(nodeEl, node);
    },
    
    // Render a comment node (sticky note style)
    renderCommentNode(node) {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'node node-comment';
        nodeEl.id = 'node-' + node.id;
        nodeEl.dataset.nodeId = node.id;
        nodeEl.style.left = (node.position?.x || 0) + 'px';
        nodeEl.style.top = (node.position?.y || 0) + 'px';
        nodeEl.style.width = (node.config?.width || 200) + 'px';
        nodeEl.style.backgroundColor = node.config?.backgroundColor || '#FFC107';
        nodeEl.style.minHeight = '60px';
        nodeEl.style.borderRadius = '4px';
        nodeEl.style.padding = '8px';
        nodeEl.style.color = '#333';
        nodeEl.style.fontSize = '12px';
        nodeEl.style.whiteSpace = 'pre-wrap';
        nodeEl.style.wordBreak = 'break-word';
        
        if (GraphState.selectedNodeIds.has(node.id)) {
            nodeEl.classList.add('selected');
        }
        
        nodeEl.textContent = node.config?.text || 'Comment';
        
        this.nodesLayer.appendChild(nodeEl);
        this.setupNodeEvents(nodeEl, node);
    },
    
    // Render a group node (frame style)
    renderGroupNode(node) {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'node node-group';
        nodeEl.id = 'node-' + node.id;
        nodeEl.dataset.nodeId = node.id;
        nodeEl.style.left = (node.position?.x || 0) + 'px';
        nodeEl.style.top = (node.position?.y || 0) + 'px';
        nodeEl.style.width = (node.config?.width || 300) + 'px';
        nodeEl.style.height = node.config?.collapsed ? '30px' : (node.config?.height || 200) + 'px';
        nodeEl.style.backgroundColor = (node.config?.backgroundColor || '#607D8B') + '20';
        nodeEl.style.border = '2px dashed ' + (node.config?.backgroundColor || '#607D8B');
        nodeEl.style.borderRadius = '8px';
        nodeEl.style.overflow = 'hidden';
        
        if (GraphState.selectedNodeIds.has(node.id)) {
            nodeEl.classList.add('selected');
        }
        
        // Title bar
        const titleBar = document.createElement('div');
        titleBar.style.backgroundColor = node.config?.backgroundColor || '#607D8B';
        titleBar.style.color = '#fff';
        titleBar.style.padding = '6px 10px';
        titleBar.style.fontWeight = '600';
        titleBar.style.fontSize = '12px';
        titleBar.style.display = 'flex';
        titleBar.style.justifyContent = 'space-between';
        titleBar.style.alignItems = 'center';
        
        const titleText = document.createElement('span');
        titleText.textContent = node.config?.title || 'Group';
        titleBar.appendChild(titleText);
        
        // Collapse toggle
        const collapseBtn = document.createElement('span');
        collapseBtn.textContent = node.config?.collapsed ? '▶' : '▼';
        collapseBtn.style.cursor = 'pointer';
        collapseBtn.onclick = (e) => {
            e.stopPropagation();
            node.config.collapsed = !node.config.collapsed;
            this.removeNode(node.id);
            this.renderGroupNode(node);
            vscode.postMessage({
                type: 'updateNodeConfig',
                payload: { nodeId: node.id, config: { collapsed: node.config.collapsed } }
            });
        };
        titleBar.appendChild(collapseBtn);
        
        nodeEl.appendChild(titleBar);
        
        this.nodesLayer.appendChild(nodeEl);
        this.setupNodeEvents(nodeEl, node);
    },
    
    // Render a loop node (container style with internal ports)
    renderLoopNode(node) {
        const nodeDef = this.getNodeDefinition(node.type);
        const color = nodeDef?.color || '#009688';
        const width = node.config?.width || 400;
        const height = node.config?.height || 250;
        
        const nodeEl = document.createElement('div');
        nodeEl.className = 'node node-loop';
        nodeEl.id = 'node-' + node.id;
        nodeEl.dataset.nodeId = node.id;
        nodeEl.style.left = (node.position?.x || 0) + 'px';
        nodeEl.style.top = (node.position?.y || 0) + 'px';
        nodeEl.style.width = width + 'px';
        nodeEl.style.height = height + 'px';
        
        if (GraphState.selectedNodeIds.has(node.id)) {
            nodeEl.classList.add('selected');
        }
        if (node.locked) {
            nodeEl.classList.add('locked');
        }
        
        // === Title bar ===
        const titleBar = document.createElement('div');
        titleBar.className = 'loop-title-bar';
        titleBar.style.backgroundColor = color;
        
        const displayName = node.config?.label || node.label || nodeDef?.name || 'For Loop';
        
        titleBar.innerHTML = \`
            <span class="node-header-icon">\${this.getNodeIcon(nodeDef)}</span>
            <span class="loop-title">\${displayName}</span>
            <span class="node-lock-btn \${node.locked ? 'locked' : ''}" title="\${node.locked ? 'Unlock position' : 'Lock position'}">
                \${node.locked ? this.getLockIcon(true) : this.getLockIcon(false)}
            </span>
        \`;
        
        // Lock button handler
        const lockBtn = titleBar.querySelector('.node-lock-btn');
        if (lockBtn) {
            lockBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                node.locked = !node.locked;
                nodeEl.classList.toggle('locked', node.locked);
                lockBtn.classList.toggle('locked', node.locked);
                lockBtn.innerHTML = node.locked ? this.getLockIcon(true) : this.getLockIcon(false);
                lockBtn.title = node.locked ? 'Unlock position' : 'Lock position';
                vscode.postMessage({
                    type: 'updateNodeLocked',
                    payload: { nodeId: node.id, locked: node.locked }
                });
            });
        }
        
        nodeEl.appendChild(titleBar);
        
        // === External ports bar (between title and container) ===
        const portsBar = document.createElement('div');
        portsBar.className = 'loop-ports-bar';
        portsBar.style.borderColor = color;
        
        // External inputs (left side of bar)
        const externalInputs = document.createElement('div');
        externalInputs.className = 'loop-external-inputs';
        for (const port of node.inputs || []) {
            const portEl = this.createPortElement(node.id, port, 'input');
            externalInputs.appendChild(portEl);
        }
        portsBar.appendChild(externalInputs);
        
        // External outputs (right side of bar)
        const externalOutputs = document.createElement('div');
        externalOutputs.className = 'loop-external-outputs';
        for (const port of node.outputs || []) {
            const portEl = this.createPortElement(node.id, port, 'output');
            externalOutputs.appendChild(portEl);
        }
        // Add external Result output port (receives data from internal result port)
        const resultOutputPort = { id: 'result', name: 'Result', dataType: 'any', description: 'Accumulated result from the loop' };
        const resultOutputEl = this.createPortElement(node.id, resultOutputPort, 'output');
        externalOutputs.appendChild(resultOutputEl);
        portsBar.appendChild(externalOutputs);
        
        nodeEl.appendChild(portsBar);
        
        // === Container area (where nodes can be placed inside) ===
        const containerArea = document.createElement('div');
        containerArea.className = 'loop-container-area';
        containerArea.style.borderColor = color;
        
        // Prevent drag initiation from container area
        containerArea.addEventListener('mousedown', (e) => {
            // Only stop propagation if clicking directly on container area (not on internal ports)
            if (e.target === containerArea || e.target.classList.contains('loop-container-area')) {
                e.stopPropagation();
            }
        });
        
        // Internal ports - Left side (Loop Body output)
        const internalLeft = document.createElement('div');
        internalLeft.className = 'loop-internal-ports loop-internal-left';
        
        // Add internal output ports (loop_body, item, index)
        const internalOutputs = [
            { id: 'loop_body', name: 'Loop Body', dataType: 'trigger', description: 'Triggers for each iteration' },
            { id: 'item', name: 'Item', dataType: 'any', description: 'Current iteration item' },
            { id: 'index', name: 'Index', dataType: 'number', description: 'Current iteration index' }
        ];
        for (const port of internalOutputs) {
            const portEl = this.createPortElement(node.id, port, 'output');
            portEl.classList.add('internal-port');
            // Mark port dot as internal for connection validation
            const portDot = portEl.querySelector('.port-dot');
            if (portDot) portDot.dataset.internal = 'true';
            internalLeft.appendChild(portEl);
        }
        containerArea.appendChild(internalLeft);
        
        // Internal ports - Right side (Loop Back and Break inputs)
        const internalRight = document.createElement('div');
        internalRight.className = 'loop-internal-ports loop-internal-right';
        
        const loopBackPort = { id: 'loop_back', name: 'Loop Back', dataType: 'trigger', description: 'Continue to next iteration' };
        const loopBackEl = this.createPortElement(node.id, loopBackPort, 'input');
        loopBackEl.classList.add('internal-port');
        // Mark port dot as internal for connection validation
        const loopBackDot = loopBackEl.querySelector('.port-dot');
        if (loopBackDot) loopBackDot.dataset.internal = 'true';
        internalRight.appendChild(loopBackEl);
        
        const breakPort = { id: 'break', name: 'Break', dataType: 'trigger', description: 'Exit the loop early' };
        const breakEl = this.createPortElement(node.id, breakPort, 'input');
        breakEl.classList.add('internal-port');
        // Mark port dot as internal for connection validation
        const breakDot = breakEl.querySelector('.port-dot');
        if (breakDot) breakDot.dataset.internal = 'true';
        internalRight.appendChild(breakEl);
        
        const resultPort = { id: 'result_in', name: 'Result', dataType: 'any', description: 'Data to output from the loop' };
        const resultEl = this.createPortElement(node.id, resultPort, 'input');
        resultEl.classList.add('internal-port');
        // Mark port dot as internal for connection validation
        const resultDot = resultEl.querySelector('.port-dot');
        if (resultDot) resultDot.dataset.internal = 'true';
        internalRight.appendChild(resultEl);
        
        containerArea.appendChild(internalRight);
        
        nodeEl.appendChild(containerArea);
        
        // Resize handle
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'loop-resize-handle';
        resizeHandle.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
        
        // Resize logic
        let isResizing = false;
        let startX, startY, startWidth, startHeight;
        
        resizeHandle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = nodeEl.offsetWidth;
            startHeight = nodeEl.offsetHeight;
            document.body.style.cursor = 'nwse-resize';
            
            const onMouseMove = (e) => {
                if (!isResizing) return;
                const dx = (e.clientX - startX) / GraphState.zoom;
                const dy = (e.clientY - startY) / GraphState.zoom;
                const newWidth = Math.max(250, startWidth + dx);
                const newHeight = Math.max(150, startHeight + dy);
                nodeEl.style.width = newWidth + 'px';
                nodeEl.style.height = newHeight + 'px';
                ConnectionRenderer.renderAll();
            };
            
            const onMouseUp = () => {
                if (!isResizing) return;
                isResizing = false;
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                
                // Save new size
                vscode.postMessage({
                    type: 'updateNodeConfig',
                    payload: { 
                        nodeId: node.id, 
                        config: { 
                            width: parseInt(nodeEl.style.width), 
                            height: parseInt(nodeEl.style.height) 
                        } 
                    }
                });
            };
            
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
        
        nodeEl.appendChild(resizeHandle);
        
        this.nodesLayer.appendChild(nodeEl);
        this.setupNodeEvents(nodeEl, node);
    },
    
    // Create a port element
    createPortElement(nodeId, port, direction) {
        const portEl = document.createElement('div');
        portEl.className = 'node-port ' + direction;
        
        const dotEl = document.createElement('div');
        dotEl.className = 'port-dot ' + direction;
        dotEl.dataset.node = nodeId;
        dotEl.dataset.port = port.id;
        dotEl.dataset.direction = direction;
        dotEl.dataset.type = port.dataType || 'any';
        dotEl.dataset.allowMultiple = port.allowMultiple ? 'true' : 'false';
        dotEl.title = port.description || port.name;
        
        // Use arrow icon for trigger ports (execution flow)
        if (port.dataType === 'trigger') {
            dotEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 17l5-5-5-5v10z"/></svg>';
        }
        
        const labelEl = document.createElement('span');
        labelEl.textContent = port.name;
        
        if (direction === 'input') {
            portEl.appendChild(dotEl);
            portEl.appendChild(labelEl);
        } else {
            portEl.appendChild(labelEl);
            portEl.appendChild(dotEl);
        }
        
        // Port events
        dotEl.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            // Check if port is interactable based on view mode
            if (!this.isPortInteractable(port.dataType)) return;
            if (direction === 'output') {
                ConnectionManager.startConnection(nodeId, port.id, port.dataType);
            }
        });
        
        dotEl.addEventListener('mouseenter', () => {
            // Check if port is interactable based on view mode
            if (!this.isPortInteractable(port.dataType)) return;
            if (direction === 'output' && !GraphState.isConnecting) {
                // Preview compatible ports
                ConnectionManager.previewCompatiblePorts(port.dataType);
            }
        });
        
        dotEl.addEventListener('mouseleave', () => {
            if (!GraphState.isConnecting) {
                ConnectionManager.clearPortHighlights();
            }
        });
        
        return portEl;
    },
    
    // Setup node event handlers
    setupNodeEvents(nodeEl, node) {
        // Mouse down - start drag or selection
        nodeEl.addEventListener('mousedown', (e) => {
            // Don't intercept port clicks
            if (e.target.classList.contains('port-dot')) return;
            
            e.stopPropagation();
            
            // Handle selection
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
                GraphState.toggleNodeSelection(node.id);
            } else if (!GraphState.selectedNodeIds.has(node.id)) {
                GraphState.selectNode(node.id, false);
            }
            
            // Start drag only if node is not locked
            if (!node.locked) {
                DragManager.startDrag(e, node.id);
            }
        });
        
        // Click - select node
        nodeEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('port-dot')) return;
            e.stopPropagation();
            
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                GraphState.selectNode(node.id, false);
            }
        });
        
        // Double click - enter subgraph
        nodeEl.addEventListener('dblclick', (e) => {
            if (node.type === 'subgraph') {
                // TODO: Enter subgraph editing
            }
        });
        
        // Context menu
        nodeEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (!GraphState.selectedNodeIds.has(node.id)) {
                GraphState.selectNode(node.id, false);
            }
            
            ContextMenu.showNodeMenu(e.clientX, e.clientY);
        });
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
    
    // Get node definition from palette
    getNodeDefinition(type) {
        for (const category of Object.values(GraphState.nodePalette)) {
            const def = category.find(d => d.type === type);
            if (def) return def;
        }
        return null;
    },
    
    // Get lock/unlock icon
    getLockIcon(locked) {
        if (locked) {
            return '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
        } else {
            return '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>';
        }
    },
    
    // Get node icon (SVG icons for better quality)
    getNodeIcon(nodeDef) {
        const svgIcons = {
            // Flow nodes
            'play': '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
            'stop': '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
            
            // Agent nodes
            'person-add': '<svg viewBox="0 0 24 24"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
            'person-remove': '<svg viewBox="0 0 24 24"><path d="M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 2v2H9v-2h8zm-7 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
            'people': '<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
            'hubot': '<svg viewBox="0 0 24 24"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2M7.5 13A2.5 2.5 0 0 0 5 15.5 2.5 2.5 0 0 0 7.5 18a2.5 2.5 0 0 0 2.5-2.5A2.5 2.5 0 0 0 7.5 13m9 0a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0 2.5-2.5 2.5 2.5 0 0 0-2.5-2.5z"/></svg>',
            'broadcast': '<svg viewBox="0 0 24 24"><path d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6.36.14A6.99 6.99 0 0 0 5 12c0 .69.1 1.36.28 2h-.01l-1.97.55A8.94 8.94 0 0 1 3 12c0-1.01.17-1.98.48-2.89l1.98.54.18.49zM12 5a7 7 0 0 0-1.33.13l-.54-1.98C10.74 3.05 11.36 3 12 3c.64 0 1.26.05 1.87.15l-.54 1.98A7 7 0 0 0 12 5zm6.36 5.14l1.98-.54c.31.91.48 1.88.48 2.89 0 .92-.13 1.8-.36 2.64l-1.97-.55c.18-.64.28-1.31.28-2a6.99 6.99 0 0 0-.64-2.95l.23.51zm-4.49 8.73l.54 1.98c-.61.1-1.23.15-1.87.15-.64 0-1.26-.05-1.87-.15l.54-1.98c.43.08.87.13 1.33.13.46 0 .9-.05 1.33-.13z"/></svg>',
            
            // Action nodes
            'terminal': '<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>',
            'watch': '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg>',
            'output': '<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>',
            'bell': '<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
            
            // Data nodes
            'book': '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>',
            'file-text': '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
            'text-format': '<svg viewBox="0 0 24 24"><path d="M5 17v2h14v-2H5zm4.5-4.2h5l.9 2.2h2.1L12.75 4h-1.5L6.5 15h2.1l.9-2.2zM12 5.98L13.87 11h-3.74L12 5.98z"/></svg>',
            'symbol-variable': '<svg viewBox="0 0 24 24"><path d="M20.41 3c1.39 2.71 1.94 5.84 1.59 9-.2 1.88-.75 3.71-1.59 5.36l-1.76-1c.73-1.44 1.2-3.01 1.36-4.64.31-2.79-.17-5.58-1.36-8.08l1.76-.64M5.35 5.64c-1.2 2.5-1.67 5.28-1.36 8.07.16 1.64.63 3.22 1.36 4.66l-1.76 1c-.84-1.65-1.39-3.48-1.59-5.37-.35-3.15.2-6.27 1.59-9l1.76.64m3.26-.42c.95-.56 2.11-.47 2.97.22l.12.1 3.54 3.54c.78.78.78 2.05 0 2.83l-3.54 3.54-.12.1c-.86.69-2.02.78-2.97.22-.95-.56-1.47-1.64-1.33-2.76l.03-.18.27-1.33-1.33.27-.18.03c-1.12.14-2.2-.38-2.76-1.33-.56-.95-.47-2.11.22-2.97l.1-.12 3.54-3.54.12-.1c.28-.22.6-.39.93-.51l.39-.01z"/></svg>',
            'code': '<svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
            
            // Control flow nodes - unique icons
            'git-compare': '<svg viewBox="0 0 24 24"><path d="M19 3h-5v2h5v13l-5-6v4H9v2h5v4l5-6v4h2V5c0-1.1-.9-2-2-2zM9 6l-5 6h4v9H2v2h8V13l5 6V3H9v3z"/></svg>',
            'split-branch': '<svg viewBox="0 0 24 24"><path d="M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zm-4 0H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z"/></svg>',
            'if-else': '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>',
            'signpost': '<svg viewBox="0 0 24 24"><path d="M13 10h5l3-3-3-3h-5V2h-2v2H4v6h7v2H6l-3 3 3 3h5v4h2v-4h7v-6h-7v-2zM6 6h11.17l1 1-1 1H6V6zm12 10H6.83l-1-1 1-1H18v2z"/></svg>',
            'switch': '<svg viewBox="0 0 24 24"><path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/></svg>',
            'loop': '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
            'repeat': '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
            
            // Parallel/Branch nodes - unique icons  
            'split': '<svg viewBox="0 0 24 24"><path d="M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zm-4 0H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z"/></svg>',
            'merge': '<svg viewBox="0 0 24 24"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>',
            
            // Legacy/compat
            'git-merge': '<svg viewBox="0 0 24 24"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>',
            'sync': '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>',
            'list-ordered': '<svg viewBox="0 0 24 24"><path d="M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z"/></svg>',
            
            // Annotation nodes
            'comment': '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
            'group': '<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>',
            
            // Misc
            'workflow': '<svg viewBox="0 0 24 24"><path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3h7zM7 9H4V5h3v4zm10 6h3v4h-3v-4zm0-10h3v4h-3V5z"/></svg>',
            'wait': '<svg viewBox="0 0 24 24"><path d="M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z"/></svg>',
            'error': '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
            'default': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>'
        };
        return svgIcons[nodeDef?.icon] || svgIcons['default'];
    },
    
    // Remove a node from DOM
    removeNode(nodeId) {
        const nodeEl = document.getElementById('node-' + nodeId);
        if (nodeEl) {
            nodeEl.remove();
        }
    },
    
    // Update node position
    updateNodePosition(nodeId, position) {
        const nodeEl = document.getElementById('node-' + nodeId);
        if (nodeEl) {
            nodeEl.style.left = position.x + 'px';
            nodeEl.style.top = position.y + 'px';
        }
    },
    
    // Update node selection visual
    updateSelection() {
        document.querySelectorAll('.node').forEach(nodeEl => {
            const nodeId = nodeEl.dataset.nodeId;
            if (GraphState.selectedNodeIds.has(nodeId)) {
                nodeEl.classList.add('selected');
            } else {
                nodeEl.classList.remove('selected');
            }
        });
        
        // Update property panel
        const selectedNodes = GraphState.getSelectedNodes();
        if (selectedNodes.length === 1) {
            PropertyPanel.render(selectedNodes[0]);
        } else if (selectedNodes.length > 1) {
            PropertyPanel.renderMultiple(selectedNodes);
        } else {
            PropertyPanel.renderEmpty();
        }
    },
    
    // Add animation class for auto-layout
    animateToPosition(nodeId, position, duration = 300) {
        const nodeEl = document.getElementById('node-' + nodeId);
        if (nodeEl) {
            nodeEl.classList.add('animating');
            nodeEl.style.left = position.x + 'px';
            nodeEl.style.top = position.y + 'px';
            
            setTimeout(() => {
                nodeEl.classList.remove('animating');
            }, duration);
        }
    }
};

// Listen for selection changes
GraphState.on('selectionChanged', () => {
    NodeRenderer.updateSelection();
});
`;
}

