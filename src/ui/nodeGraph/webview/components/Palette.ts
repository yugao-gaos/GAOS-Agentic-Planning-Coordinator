// ============================================================================
// Palette - Node palette with search/filter
// ============================================================================

/**
 * Get the Palette module code for the webview
 */
export function getPaletteCode(): string {
    return `
// ============================================================================
// Palette - Node palette with search and categories
// ============================================================================

const Palette = {
    container: null,
    searchInput: null,
    contentEl: null,
    
    init() {
        this.container = document.getElementById('node-palette');
        this.searchInput = document.getElementById('palette-search');
        this.contentEl = document.getElementById('palette-content');
        
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => this.filterNodes());
        }
    },
    
    // Render the palette
    render() {
        if (!this.contentEl) return;
        this.contentEl.innerHTML = '';
        
        const categories = ['flow', 'agent', 'data', 'actions', 'parallel', 'annotation'];
        
        for (const category of categories) {
            let nodes = GraphState.nodePalette[category];
            if (!nodes || nodes.length === 0) continue;
            
            // Filter out auto-added nodes (start, agent_bench - only one allowed each)
            nodes = nodes.filter(n => n.type !== 'start' && n.type !== 'agent_bench');
            if (nodes.length === 0) continue;
            
            const categoryEl = document.createElement('div');
            categoryEl.className = 'palette-category';
            categoryEl.dataset.category = category;
            
            const headerEl = document.createElement('div');
            headerEl.className = 'category-header';
            headerEl.textContent = this.formatCategoryName(category);
            categoryEl.appendChild(headerEl);
            
            // Icon grid container
            const gridEl = document.createElement('div');
            gridEl.className = 'palette-grid';
            
            for (const nodeDef of nodes) {
                const nodeEl = this.createNodeElement(nodeDef);
                gridEl.appendChild(nodeEl);
            }
            
            categoryEl.appendChild(gridEl);
            this.contentEl.appendChild(categoryEl);
        }
    },
    
    // Create a palette node element (icon button style)
    createNodeElement(nodeDef) {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'palette-node';
        nodeEl.draggable = true;
        nodeEl.dataset.type = nodeDef.type;
        nodeEl.dataset.name = nodeDef.name.toLowerCase();
        nodeEl.title = nodeDef.name + '\\n' + (nodeDef.description || '');
        
        const icon = NodeRenderer.getNodeIcon(nodeDef);
        nodeEl.innerHTML = \`<span class="palette-icon">\${icon}</span>\`;
        
        nodeEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('nodeType', nodeDef.type);
            nodeEl.classList.add('dragging');
        });
        
        nodeEl.addEventListener('dragend', () => {
            nodeEl.classList.remove('dragging');
        });
        
        // Double-click to add at center
        nodeEl.addEventListener('dblclick', () => {
            const rect = Canvas.container.getBoundingClientRect();
            const centerX = (rect.width / 2 - GraphState.panX) / GraphState.zoom;
            const centerY = (rect.height / 2 - GraphState.panY) / GraphState.zoom;
            
            vscode.postMessage({
                type: 'addNode',
                payload: {
                    type: nodeDef.type,
                    position: {
                        x: GraphState.snapToGridValue(centerX),
                        y: GraphState.snapToGridValue(centerY)
                    }
                }
            });
        });
        
        return nodeEl;
    },
    
    // Filter nodes by search text
    filterNodes() {
        const searchText = (this.searchInput?.value || '').toLowerCase().trim();
        
        document.querySelectorAll('.palette-node').forEach(nodeEl => {
            const name = nodeEl.dataset.name || '';
            const type = nodeEl.dataset.type || '';
            
            if (searchText === '' || name.includes(searchText) || type.includes(searchText)) {
                nodeEl.classList.remove('hidden');
            } else {
                nodeEl.classList.add('hidden');
            }
        });
        
        // Hide empty categories
        document.querySelectorAll('.palette-category').forEach(catEl => {
            const visibleNodes = catEl.querySelectorAll('.palette-node:not(.hidden)');
            if (visibleNodes.length === 0) {
                catEl.style.display = 'none';
            } else {
                catEl.style.display = '';
            }
        });
    },
    
    // Format category name for display
    formatCategoryName(category) {
        return category.charAt(0).toUpperCase() + category.slice(1);
    },
    
    // Get all node definitions as flat array
    getAllNodeDefinitions() {
        const allNodes = [];
        for (const category of Object.keys(GraphState.nodePalette)) {
            for (const nodeDef of GraphState.nodePalette[category]) {
                allNodes.push({ ...nodeDef, category });
            }
        }
        return allNodes;
    }
};
`;
}

