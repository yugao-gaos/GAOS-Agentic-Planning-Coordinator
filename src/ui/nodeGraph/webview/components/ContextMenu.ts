// ============================================================================
// ContextMenu - Right-click menus
// ============================================================================

/**
 * Get the ContextMenu module code for the webview
 */
export function getContextMenuCode(): string {
    return `
// ============================================================================
// ContextMenu - Context menu management
// ============================================================================

const ContextMenu = {
    menu: null,
    
    init() {
        // Close menu on click elsewhere
        document.addEventListener('click', () => this.hide());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hide();
        });
    },
    
    // Create menu element
    createMenu(items) {
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        
        for (const item of items) {
            if (item.type === 'divider') {
                const divider = document.createElement('div');
                divider.className = 'context-menu-divider';
                menu.appendChild(divider);
            } else if (item.type === 'submenu') {
                const submenu = document.createElement('div');
                submenu.className = 'context-menu-item context-menu-submenu';
                submenu.innerHTML = item.label;
                
                const subMenuEl = this.createMenu(item.items);
                submenu.appendChild(subMenuEl);
                menu.appendChild(submenu);
            } else {
                const menuItem = document.createElement('div');
                menuItem.className = 'context-menu-item';
                if (item.disabled) menuItem.classList.add('disabled');
                
                menuItem.innerHTML = item.label;
                if (item.shortcut) {
                    menuItem.innerHTML += '<span class="shortcut">' + item.shortcut + '</span>';
                }
                
                if (!item.disabled) {
                    menuItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.hide();
                        if (item.action) item.action();
                    });
                }
                
                menu.appendChild(menuItem);
            }
        }
        
        return menu;
    },
    
    // Show menu at position
    show(x, y, items) {
        this.hide();
        
        this.menu = this.createMenu(items);
        document.body.appendChild(this.menu);
        
        // Position menu, keeping it on screen
        const rect = this.menu.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        
        if (x + rect.width > windowWidth) {
            x = windowWidth - rect.width - 10;
        }
        if (y + rect.height > windowHeight) {
            y = windowHeight - rect.height - 10;
        }
        
        this.menu.style.left = x + 'px';
        this.menu.style.top = y + 'px';
    },
    
    // Hide menu
    hide() {
        if (this.menu) {
            this.menu.remove();
            this.menu = null;
        }
    },
    
    // Show canvas context menu
    showCanvasMenu(screenX, screenY, canvasPos) {
        const items = [
            {
                type: 'submenu',
                label: 'Add Node',
                items: this.getAddNodeItems(canvasPos)
            },
            { type: 'divider' },
            {
                label: 'Paste',
                shortcut: 'Ctrl+V',
                disabled: !GraphState.clipboard,
                action: () => ClipboardManager.paste(canvasPos)
            },
            { type: 'divider' },
            {
                label: 'Select All',
                shortcut: 'Ctrl+A',
                action: () => GraphState.selectAllNodes()
            },
            {
                label: 'Fit to View',
                shortcut: 'F',
                action: () => Canvas.fitToView()
            },
            {
                label: 'Reset View',
                shortcut: 'Home',
                action: () => Canvas.resetView()
            }
        ];
        
        this.show(screenX, screenY, items);
    },
    
    // Get add node submenu items
    getAddNodeItems(canvasPos) {
        const items = [];
        const categories = ['flow', 'agent', 'actions', 'data', 'control'];
        
        for (const category of categories) {
            const nodes = GraphState.nodePalette[category];
            if (!nodes || nodes.length === 0) continue;
            
            items.push({
                type: 'submenu',
                label: category.charAt(0).toUpperCase() + category.slice(1),
                items: nodes.map(nodeDef => ({
                    label: nodeDef.name,
                    action: () => {
                        vscode.postMessage({
                            type: 'addNode',
                            payload: {
                                type: nodeDef.type,
                                position: {
                                    x: GraphState.snapToGridValue(canvasPos.x),
                                    y: GraphState.snapToGridValue(canvasPos.y)
                                }
                            }
                        });
                    }
                }))
            });
        }
        
        return items;
    },
    
    // Show node context menu
    showNodeMenu(screenX, screenY) {
        const hasMultiple = GraphState.selectedNodeIds.size > 1;
        const canDelete = Array.from(GraphState.selectedNodeIds).some(id => {
            const node = GraphState.getNode(id);
            return node && node.type !== 'start';
        });
        
        const items = [
            {
                label: hasMultiple ? 'Copy Nodes' : 'Copy',
                shortcut: 'Ctrl+C',
                action: () => ClipboardManager.copy()
            },
            {
                label: hasMultiple ? 'Cut Nodes' : 'Cut',
                shortcut: 'Ctrl+X',
                action: () => ClipboardManager.cut()
            },
            {
                label: hasMultiple ? 'Duplicate Nodes' : 'Duplicate',
                shortcut: 'Ctrl+D',
                action: () => ClipboardManager.duplicate()
            },
            { type: 'divider' },
            {
                label: hasMultiple ? 'Delete Nodes' : 'Delete',
                shortcut: 'Del',
                disabled: !canDelete,
                action: () => {
                    const nodeIds = Array.from(GraphState.selectedNodeIds).filter(id => {
                        const node = GraphState.getNode(id);
                        return node && node.type !== 'start';
                    });
                    if (nodeIds.length > 0) {
                        vscode.postMessage({
                            type: 'deleteNodes',
                            payload: { nodeIds }
                        });
                    }
                }
            }
        ];
        
        // Add alignment options if multiple nodes selected
        if (hasMultiple) {
            items.push(
                { type: 'divider' },
                {
                    type: 'submenu',
                    label: 'Align',
                    items: [
                        { label: 'Align Left', action: () => Toolbar.alignNodes('left') },
                        { label: 'Align Right', action: () => Toolbar.alignNodes('right') },
                        { label: 'Align Top', action: () => Toolbar.alignNodes('top') },
                        { label: 'Align Bottom', action: () => Toolbar.alignNodes('bottom') },
                        { type: 'divider' },
                        { label: 'Center Horizontally', action: () => Toolbar.alignNodes('center-h') },
                        { label: 'Center Vertically', action: () => Toolbar.alignNodes('center-v') }
                    ]
                }
            );
            
            if (GraphState.selectedNodeIds.size >= 3) {
                items.push({
                    type: 'submenu',
                    label: 'Distribute',
                    items: [
                        { label: 'Distribute Horizontally', action: () => Toolbar.distributeNodes('horizontal') },
                        { label: 'Distribute Vertically', action: () => Toolbar.distributeNodes('vertical') }
                    ]
                });
            }
        }
        
        this.show(screenX, screenY, items);
    },
    
    // Show connection context menu
    showConnectionMenu(screenX, screenY, connectionId) {
        const items = [
            {
                label: 'Delete Connection',
                shortcut: 'Del',
                action: () => {
                    vscode.postMessage({
                        type: 'deleteConnection',
                        payload: { connectionId }
                    });
                }
            }
        ];
        
        this.show(screenX, screenY, items);
    }
};
`;
}

