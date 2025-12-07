// ============================================================================
// Breadcrumb - Subgraph navigation trail
// ============================================================================

/**
 * Get the Breadcrumb module code for the webview
 */
export function getBreadcrumbCode(): string {
    return `
// ============================================================================
// Breadcrumb - Subgraph navigation
// ============================================================================

const Breadcrumb = {
    container: null,
    
    init() {
        this.container = document.getElementById('breadcrumb');
    },
    
    // Update breadcrumb display
    update() {
        if (!this.container) return;
        
        const stack = GraphState.navigationStack;
        
        if (stack.length === 0) {
            this.container.classList.add('hidden');
            return;
        }
        
        this.container.classList.remove('hidden');
        
        let html = '';
        
        // Root graph
        html += '<span class="breadcrumb-item" onclick="Breadcrumb.navigateTo(0)">Main</span>';
        
        // Subgraph stack
        for (let i = 0; i < stack.length; i++) {
            html += '<span class="breadcrumb-separator">›</span>';
            html += '<span class="breadcrumb-item" onclick="Breadcrumb.navigateTo(' + (i + 1) + ')">' + stack[i].graphName + '</span>';
        }
        
        this.container.innerHTML = html;
    },
    
    // Navigate to a level
    navigateTo(level) {
        if (level === 0) {
            // Go to root
            this.exitToRoot();
        } else {
            // Go to specific subgraph level
            while (GraphState.navigationStack.length > level) {
                this.exitSubgraph();
            }
        }
    },
    
    // Enter a subgraph
    enterSubgraph(nodeId) {
        const node = GraphState.getNode(nodeId);
        if (!node || node.type !== 'subgraph') return;
        
        // Save current graph state
        GraphState.navigationStack.push({
            graphName: node.label || node.config?.name || 'Subgraph',
            graph: JSON.parse(JSON.stringify(GraphState.graph)),
            subgraphNodeId: nodeId
        });
        
        GraphState.currentSubgraphNodeId = nodeId;
        
        // Load subgraph
        // TODO: Load the actual subgraph content from node.config
        
        this.update();
    },
    
    // Exit current subgraph
    exitSubgraph() {
        if (GraphState.navigationStack.length === 0) return;
        
        const parentState = GraphState.navigationStack.pop();
        GraphState.graph = parentState.graph;
        GraphState.currentSubgraphNodeId = null;
        
        if (GraphState.navigationStack.length > 0) {
            const current = GraphState.navigationStack[GraphState.navigationStack.length - 1];
            GraphState.currentSubgraphNodeId = current.subgraphNodeId;
        }
        
        // Re-render
        NodeRenderer.renderAll();
        ConnectionRenderer.renderAll();
        Minimap.update();
        
        this.update();
    },
    
    // Exit all the way to root
    exitToRoot() {
        while (GraphState.navigationStack.length > 0) {
            this.exitSubgraph();
        }
    }
};
`;
}

