// ============================================================================
// QuickAdd - Ctrl+P quick add modal
// ============================================================================

/**
 * Get the QuickAdd module code for the webview
 */
export function getQuickAddCode(): string {
    return `
// ============================================================================
// QuickAdd - Quick node add modal (Ctrl+P)
// ============================================================================

const QuickAdd = {
    modal: null,
    input: null,
    list: null,
    selectedIndex: 0,
    filteredNodes: [],
    
    // Show the quick add modal
    show() {
        if (this.modal) {
            this.hide();
            return;
        }
        
        this.modal = document.createElement('div');
        this.modal.className = 'quick-add-modal';
        this.modal.innerHTML = \`
            <input type="text" class="quick-add-input" placeholder="Type to search nodes..." autofocus>
            <div class="quick-add-list"></div>
        \`;
        
        document.body.appendChild(this.modal);
        
        this.input = this.modal.querySelector('.quick-add-input');
        this.list = this.modal.querySelector('.quick-add-list');
        
        this.input.addEventListener('input', () => this.filter());
        this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
        
        this.input.focus();
        this.filter();
        
        // Close on click outside
        document.addEventListener('click', this.handleOutsideClick);
    },
    
    // Hide the modal
    hide() {
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
            this.input = null;
            this.list = null;
        }
        document.removeEventListener('click', this.handleOutsideClick);
    },
    
    // Handle outside click
    handleOutsideClick(e) {
        if (QuickAdd.modal && !QuickAdd.modal.contains(e.target)) {
            QuickAdd.hide();
        }
    },
    
    // Filter nodes
    filter() {
        const searchText = (this.input?.value || '').toLowerCase().trim();
        
        this.filteredNodes = [];
        
        for (const category of Object.keys(GraphState.nodePalette)) {
            for (const nodeDef of GraphState.nodePalette[category]) {
                if (searchText === '' || 
                    nodeDef.name.toLowerCase().includes(searchText) ||
                    nodeDef.type.toLowerCase().includes(searchText)) {
                    this.filteredNodes.push({ ...nodeDef, category });
                }
            }
        }
        
        this.selectedIndex = 0;
        this.renderList();
    },
    
    // Render filtered list
    renderList() {
        if (!this.list) return;
        
        this.list.innerHTML = this.filteredNodes.slice(0, 15).map((node, i) => \`
            <div class="quick-add-item\${i === this.selectedIndex ? ' selected' : ''}" data-index="\${i}">
                <span>\${NodeRenderer.getNodeIcon(node)}</span>
                <span>\${node.name}</span>
                <span class="category">\${node.category}</span>
            </div>
        \`).join('');
        
        // Click handlers
        this.list.querySelectorAll('.quick-add-item').forEach(item => {
            item.addEventListener('click', () => {
                this.selectedIndex = parseInt(item.dataset.index);
                this.addSelected();
            });
        });
    },
    
    // Handle keyboard navigation
    handleKeydown(e) {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (this.selectedIndex < this.filteredNodes.length - 1) {
                    this.selectedIndex++;
                    this.renderList();
                }
                break;
                
            case 'ArrowUp':
                e.preventDefault();
                if (this.selectedIndex > 0) {
                    this.selectedIndex--;
                    this.renderList();
                }
                break;
                
            case 'Enter':
                e.preventDefault();
                this.addSelected();
                break;
                
            case 'Escape':
                this.hide();
                break;
        }
    },
    
    // Add the selected node
    addSelected() {
        const node = this.filteredNodes[this.selectedIndex];
        if (!node) return;
        
        // Add at canvas center
        const rect = Canvas.container.getBoundingClientRect();
        const centerX = (rect.width / 2 - GraphState.panX) / GraphState.zoom;
        const centerY = (rect.height / 2 - GraphState.panY) / GraphState.zoom;
        
        vscode.postMessage({
            type: 'addNode',
            payload: {
                type: node.type,
                position: {
                    x: GraphState.snapToGridValue(centerX),
                    y: GraphState.snapToGridValue(centerY)
                }
            }
        });
        
        this.hide();
    }
};
`;
}

