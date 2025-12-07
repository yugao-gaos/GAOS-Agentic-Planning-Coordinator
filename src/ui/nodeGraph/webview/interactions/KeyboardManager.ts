// ============================================================================
// KeyboardManager - Keyboard shortcuts
// ============================================================================

/**
 * Get the KeyboardManager module code for the webview
 */
export function getKeyboardManagerCode(): string {
    return `
// ============================================================================
// KeyboardManager - Keyboard shortcuts
// ============================================================================

const KeyboardManager = {
    init() {
        document.addEventListener('keydown', (e) => this.handleKeydown(e));
    },
    
    handleKeydown(e) {
        // Don't handle if typing in an input
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
            // Still allow Escape
            if (e.key === 'Escape') {
                activeEl.blur();
                PropertyPanel.hideAutocomplete();
            }
            return;
        }
        
        const ctrl = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;
        
        switch (e.key) {
            // Save
            case 's':
                if (ctrl) {
                    e.preventDefault();
                    vscode.postMessage({ type: 'save' });
                }
                break;
            
            // Undo/Redo
            case 'z':
                if (ctrl && !shift) {
                    e.preventDefault();
                    UndoManager.undo();
                    vscode.postMessage({ type: 'undo' });
                } else if (ctrl && shift) {
                    e.preventDefault();
                    UndoManager.redo();
                    vscode.postMessage({ type: 'redo' });
                }
                break;
                
            case 'y':
                if (ctrl) {
                    e.preventDefault();
                    UndoManager.redo();
                    vscode.postMessage({ type: 'redo' });
                }
                break;
            
            // Select all
            case 'a':
                if (ctrl) {
                    e.preventDefault();
                    GraphState.selectAllNodes();
                }
                break;
            
            // Copy
            case 'c':
                if (ctrl) {
                    e.preventDefault();
                    ClipboardManager.copy();
                }
                break;
            
            // Cut
            case 'x':
                if (ctrl) {
                    e.preventDefault();
                    ClipboardManager.cut();
                }
                break;
            
            // Paste
            case 'v':
                if (ctrl) {
                    e.preventDefault();
                    ClipboardManager.paste();
                }
                break;
            
            // Duplicate
            case 'd':
                if (ctrl) {
                    e.preventDefault();
                    ClipboardManager.duplicate();
                }
                break;
            
            // Delete
            case 'Delete':
            case 'Backspace':
                if (GraphState.selectedConnectionId) {
                    // Delete selected connection
                    vscode.postMessage({
                        type: 'deleteConnection',
                        payload: { connectionId: GraphState.selectedConnectionId }
                    });
                    GraphState.selectedConnectionId = null;
                } else if (GraphState.selectedNodeIds.size > 0) {
                    // Delete selected nodes
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
                break;
            
            // Quick add
            case 'p':
                if (ctrl) {
                    e.preventDefault();
                    QuickAdd.show();
                }
                break;
            
            // Group
            case 'g':
                if (ctrl && !shift) {
                    e.preventDefault();
                    // TODO: Group nodes
                } else if (ctrl && shift) {
                    e.preventDefault();
                    // TODO: Ungroup nodes
                }
                break;
            
            // Fit to view
            case 'f':
            case 'F':
                if (!ctrl) {
                    e.preventDefault();
                    Canvas.fitToView();
                }
                break;
            
            // Reset view
            case 'Home':
                e.preventDefault();
                Canvas.resetView();
                break;
            
            // Zoom shortcuts
            case '0':
                if (ctrl) {
                    e.preventDefault();
                    Canvas.setZoom(1);
                }
                break;
                
            case '1':
                if (ctrl) {
                    e.preventDefault();
                    Canvas.setZoom(0.5);
                }
                break;
                
            case '2':
                if (ctrl) {
                    e.preventDefault();
                    Canvas.setZoom(1);
                }
                break;
                
            case '3':
                if (ctrl) {
                    e.preventDefault();
                    Canvas.setZoom(1.5);
                }
                break;
            
            // Escape
            case 'Escape':
                GraphState.clearSelection();
                QuickAdd.hide();
                ContextMenu.hide();
                break;
        }
    }
};
`;
}

