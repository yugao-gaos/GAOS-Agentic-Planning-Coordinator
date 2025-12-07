// ============================================================================
// PropertyPanel - Node config editors
// ============================================================================

/**
 * Get the PropertyPanel module code for the webview
 */
export function getPropertyPanelCode(): string {
    return `
// ============================================================================
// PropertyPanel - Node property editing
// ============================================================================

const PropertyPanel = {
    container: null,
    currentNode: null,
    autocompleteDropdown: null,
    
    init() {
        this.container = document.getElementById('properties-content');
    },
    
    // Render properties for a node
    render(node) {
        if (!this.container) return;
        this.currentNode = node;
        
        const nodeDef = NodeRenderer.getNodeDefinition(node.type);
        
        let html = '';
        
        // Node info section
        html += '<div class="property-group">';
        html += '<div class="property-label">Node ID</div>';
        html += '<input type="text" class="property-input" value="' + node.id + '" readonly>';
        html += '</div>';
        
        html += '<div class="property-group">';
        html += '<div class="property-label">Type</div>';
        html += '<input type="text" class="property-input" value="' + (nodeDef?.name || node.type) + '" readonly>';
        html += '</div>';
        
        html += '<div class="property-group">';
        html += '<div class="property-label">Label</div>';
        html += '<input type="text" class="property-input" data-field="__label__" value="' + (node.label || '') + '" placeholder="Custom label...">';
        html += '</div>';
        
        // Config fields
        if (nodeDef?.configSchema?.fields) {
            for (const field of nodeDef.configSchema.fields) {
                html += this.renderField(field, node.config);
            }
        }
        
        // Delete button (except for start node)
        if (node.type !== 'start') {
            html += '<div class="property-group" style="margin-top: 24px;">';
            html += '<button class="btn-delete" onclick="PropertyPanel.deleteNode()">Delete Node</button>';
            html += '</div>';
        }
        
        this.container.innerHTML = html;
        this.setupFieldListeners();
    },
    
    // Render a single config field
    renderField(field, config) {
        const value = config?.[field.name] ?? field.defaultValue ?? '';
        const escapedValue = this.escapeHtml(String(value));
        
        let html = '<div class="property-group">';
        html += '<div class="property-label">' + field.label + (field.required ? ' *' : '') + '</div>';
        
        if (field.description) {
            html += '<div class="property-description">' + field.description + '</div>';
        }
        
        switch (field.type) {
            case 'boolean':
                html += '<div class="property-row">';
                html += '<input type="checkbox" class="property-input" data-field="' + field.name + '" ' + (value ? 'checked' : '') + '>';
                html += '<span>Enabled</span>';
                html += '</div>';
                break;
                
            case 'number':
                html += '<input type="number" class="property-input" data-field="' + field.name + '" value="' + escapedValue + '"';
                if (field.min !== undefined) html += ' min="' + field.min + '"';
                if (field.max !== undefined) html += ' max="' + field.max + '"';
                html += '>';
                break;
                
            case 'select':
                html += '<select class="property-input" data-field="' + field.name + '">';
                // Use dynamic options if specified, otherwise use static options
                const options = field.dynamicOptions 
                    ? (GraphState.dynamicOptions[field.dynamicOptions] || [])
                    : (field.options || []);
                for (const opt of options) {
                    html += '<option value="' + opt.value + '"' + (value === opt.value ? ' selected' : '') + '>' + opt.label + '</option>';
                }
                html += '</select>';
                break;
                
            case 'multiline':
            case 'template':
                html += '<textarea class="property-input' + (field.type === 'template' ? ' template-input' : '') + '" data-field="' + field.name + '" data-type="' + field.type + '">' + escapedValue + '</textarea>';
                break;
                
            case 'expression':
                html += '<input type="text" class="property-input expression-input" data-field="' + field.name + '" data-type="expression" value="' + escapedValue + '" placeholder="e.g., value > 10 or {{variable}}">';
                break;
                
            default: // string
                html += '<input type="text" class="property-input" data-field="' + field.name + '" value="' + escapedValue + '">';
        }
        
        html += '</div>';
        return html;
    },
    
    // Render for multiple selected nodes
    renderMultiple(nodes) {
        if (!this.container) return;
        this.currentNode = null;
        
        this.container.innerHTML = \`
            <div class="placeholder">
                <p>\${nodes.length} nodes selected</p>
                <p style="margin-top: 12px; font-size: 11px;">
                    Use alignment tools in the toolbar to arrange selected nodes.
                </p>
                <button class="btn-delete" style="margin-top: 16px;" onclick="PropertyPanel.deleteSelectedNodes()">
                    Delete Selected Nodes
                </button>
            </div>
        \`;
    },
    
    // Render empty state (workflow settings)
    renderEmpty() {
        if (!this.container) return;
        this.currentNode = null;
        
        if (!GraphState.graph) {
            this.container.innerHTML = '<p class="placeholder">No workflow loaded</p>';
            return;
        }
        
        // Show workflow settings
        const graph = GraphState.graph;
        
        let html = '<div class="property-group">';
        html += '<div class="property-label">Workflow Name</div>';
        html += '<input type="text" class="property-input" data-graph-field="name" value="' + this.escapeHtml(graph.name || '') + '">';
        html += '</div>';
        
        html += '<div class="property-group">';
        html += '<div class="property-label">Version</div>';
        html += '<input type="text" class="property-input" data-graph-field="version" value="' + this.escapeHtml(graph.version || '1.0') + '">';
        html += '</div>';
        
        html += '<div class="property-group">';
        html += '<div class="property-label">Description</div>';
        html += '<textarea class="property-input" data-graph-field="description">' + this.escapeHtml(graph.description || '') + '</textarea>';
        html += '</div>';
        
        // Parameters section
        html += '<div class="property-group">';
        html += '<div class="property-label">Parameters</div>';
        html += '<div id="params-list">';
        if (graph.parameters) {
            for (let i = 0; i < graph.parameters.length; i++) {
                html += this.renderParameterItem(graph.parameters[i], i);
            }
        }
        html += '</div>';
        html += '<button style="margin-top: 8px; width: 100%;" class="property-input" onclick="PropertyPanel.addParameter()">+ Add Parameter</button>';
        html += '</div>';
        
        // Variables section
        html += '<div class="property-group">';
        html += '<div class="property-label">Variables</div>';
        html += '<div id="vars-list">';
        if (graph.variables) {
            for (let i = 0; i < graph.variables.length; i++) {
                html += this.renderVariableItem(graph.variables[i], i);
            }
        }
        html += '</div>';
        html += '<button style="margin-top: 8px; width: 100%;" class="property-input" onclick="PropertyPanel.addVariable()">+ Add Variable</button>';
        html += '</div>';
        
        this.container.innerHTML = html;
        this.setupGraphFieldListeners();
    },
    
    // Render parameter item
    renderParameterItem(param, index) {
        return \`
            <div class="property-row" style="margin-bottom: 4px;" data-param-index="\${index}">
                <input type="text" class="property-input" style="flex: 1;" value="\${this.escapeHtml(param.name)}" 
                    onchange="PropertyPanel.updateParameter(\${index}, 'name', this.value)" placeholder="name">
                <select class="property-input" style="width: 70px;" onchange="PropertyPanel.updateParameter(\${index}, 'type', this.value)">
                    <option value="string" \${param.type === 'string' ? 'selected' : ''}>str</option>
                    <option value="number" \${param.type === 'number' ? 'selected' : ''}>num</option>
                    <option value="boolean" \${param.type === 'boolean' ? 'selected' : ''}>bool</option>
                </select>
                <button class="property-input" style="width: 30px; padding: 4px;" onclick="PropertyPanel.removeParameter(\${index})">×</button>
            </div>
        \`;
    },
    
    // Render variable item
    renderVariableItem(variable, index) {
        return \`
            <div class="property-row" style="margin-bottom: 4px;" data-var-index="\${index}">
                <input type="text" class="property-input" style="flex: 1;" value="\${this.escapeHtml(variable.id)}" 
                    onchange="PropertyPanel.updateVariable(\${index}, 'id', this.value)" placeholder="id">
                <select class="property-input" style="width: 70px;" onchange="PropertyPanel.updateVariable(\${index}, 'type', this.value)">
                    <option value="string" \${variable.type === 'string' ? 'selected' : ''}>str</option>
                    <option value="number" \${variable.type === 'number' ? 'selected' : ''}>num</option>
                    <option value="boolean" \${variable.type === 'boolean' ? 'selected' : ''}>bool</option>
                    <option value="object" \${variable.type === 'object' ? 'selected' : ''}>obj</option>
                    <option value="array" \${variable.type === 'array' ? 'selected' : ''}>arr</option>
                </select>
                <button class="property-input" style="width: 30px; padding: 4px;" onclick="PropertyPanel.removeVariable(\${index})">×</button>
            </div>
        \`;
    },
    
    // Setup field change listeners
    setupFieldListeners() {
        const inputs = this.container.querySelectorAll('.property-input[data-field]');
        
        inputs.forEach(input => {
            const fieldName = input.dataset.field;
            const fieldType = input.dataset.type;
            
            // Handle expression/template autocomplete
            if (fieldType === 'expression' || fieldType === 'template') {
                input.addEventListener('input', (e) => this.handleAutocomplete(e, input));
                input.addEventListener('keydown', (e) => this.handleAutocompleteKeydown(e));
            }
            
            input.addEventListener('change', () => {
                let value;
                if (input.type === 'checkbox') {
                    value = input.checked;
                } else if (input.type === 'number') {
                    value = parseFloat(input.value);
                } else {
                    value = input.value;
                }
                
                if (fieldName === '__label__') {
                    // Update node label
                    if (this.currentNode) {
                        this.currentNode.label = value || undefined;
                        vscode.postMessage({
                            type: 'updateNodeLabel',
                            payload: { nodeId: this.currentNode.id, label: value }
                        });
                    }
                } else if (this.currentNode) {
                    vscode.postMessage({
                        type: 'updateNodeConfig',
                        payload: { nodeId: this.currentNode.id, config: { [fieldName]: value } }
                    });
                }
            });
        });
    },
    
    // Setup graph field listeners
    setupGraphFieldListeners() {
        const inputs = this.container.querySelectorAll('.property-input[data-graph-field]');
        
        inputs.forEach(input => {
            const fieldName = input.dataset.graphField;
            
            input.addEventListener('change', () => {
                if (GraphState.graph) {
                    GraphState.graph[fieldName] = input.value;
                    vscode.postMessage({
                        type: 'updateGraphMeta',
                        payload: { [fieldName]: input.value }
                    });
                    
                    // Update toolbar graph name if applicable
                    if (fieldName === 'name') {
                        const nameInput = document.getElementById('graph-name');
                        if (nameInput) nameInput.value = input.value;
                    }
                }
            });
        });
    },
    
    // Handle autocomplete for expressions/templates
    handleAutocomplete(e, input) {
        const value = input.value;
        const cursorPos = input.selectionStart;
        
        // Check if we just typed {{ or are inside {{ }}
        const beforeCursor = value.substring(0, cursorPos);
        const match = beforeCursor.match(/\\{\\{([^}]*)$/);
        
        if (match) {
            const searchText = match[1].toLowerCase();
            this.showAutocomplete(input, searchText);
        } else {
            this.hideAutocomplete();
        }
    },
    
    // Show autocomplete dropdown
    showAutocomplete(input, searchText) {
        if (!this.autocompleteDropdown) {
            this.autocompleteDropdown = document.createElement('div');
            this.autocompleteDropdown.className = 'autocomplete-dropdown';
            document.body.appendChild(this.autocompleteDropdown);
        }
        
        // Get suggestions
        const suggestions = this.getAutocompleteSuggestions(searchText);
        
        if (suggestions.length === 0) {
            this.hideAutocomplete();
            return;
        }
        
        // Render suggestions
        this.autocompleteDropdown.innerHTML = suggestions.map((s, i) => \`
            <div class="autocomplete-item\${i === 0 ? ' selected' : ''}" data-value="\${s.value}" data-index="\${i}">
                <span>\${s.label}</span>
                <span class="type">\${s.type}</span>
            </div>
        \`).join('');
        
        // Position dropdown
        const rect = input.getBoundingClientRect();
        this.autocompleteDropdown.style.display = 'block';
        this.autocompleteDropdown.style.left = rect.left + 'px';
        this.autocompleteDropdown.style.top = (rect.bottom + 2) + 'px';
        this.autocompleteDropdown.style.width = rect.width + 'px';
        
        // Click handler
        this.autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
                this.insertAutocomplete(input, item.dataset.value);
            });
        });
    },
    
    // Get autocomplete suggestions
    getAutocompleteSuggestions(searchText) {
        const suggestions = [];
        
        // Add variables
        if (GraphState.graph?.variables) {
            for (const v of GraphState.graph.variables) {
                if (v.id.toLowerCase().includes(searchText)) {
                    suggestions.push({
                        label: v.id,
                        value: v.id,
                        type: 'variable'
                    });
                }
            }
        }
        
        // Add parameters
        if (GraphState.graph?.parameters) {
            for (const p of GraphState.graph.parameters) {
                if (p.name.toLowerCase().includes(searchText)) {
                    suggestions.push({
                        label: 'parameters.' + p.name,
                        value: 'parameters.' + p.name,
                        type: 'param'
                    });
                }
            }
        }
        
        // Add node outputs
        if (GraphState.graph?.nodes) {
            for (const node of GraphState.graph.nodes) {
                for (const output of node.outputs || []) {
                    const ref = node.id + '.' + output.id;
                    if (ref.toLowerCase().includes(searchText)) {
                        suggestions.push({
                            label: ref,
                            value: ref,
                            type: 'output'
                        });
                    }
                }
            }
        }
        
        return suggestions.slice(0, 10);
    },
    
    // Handle autocomplete keyboard navigation
    handleAutocompleteKeydown(e) {
        if (!this.autocompleteDropdown || this.autocompleteDropdown.style.display === 'none') return;
        
        const items = this.autocompleteDropdown.querySelectorAll('.autocomplete-item');
        const selected = this.autocompleteDropdown.querySelector('.autocomplete-item.selected');
        const selectedIndex = selected ? parseInt(selected.dataset.index) : 0;
        
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (selectedIndex < items.length - 1) {
                    selected?.classList.remove('selected');
                    items[selectedIndex + 1].classList.add('selected');
                }
                break;
                
            case 'ArrowUp':
                e.preventDefault();
                if (selectedIndex > 0) {
                    selected?.classList.remove('selected');
                    items[selectedIndex - 1].classList.add('selected');
                }
                break;
                
            case 'Tab':
            case 'Enter':
                if (selected) {
                    e.preventDefault();
                    this.insertAutocomplete(e.target, selected.dataset.value);
                }
                break;
                
            case 'Escape':
                this.hideAutocomplete();
                break;
        }
    },
    
    // Insert autocomplete value
    insertAutocomplete(input, value) {
        const cursorPos = input.selectionStart;
        const text = input.value;
        
        // Find the start of {{
        const beforeCursor = text.substring(0, cursorPos);
        const match = beforeCursor.match(/\\{\\{([^}]*)$/);
        
        if (match) {
            const startPos = cursorPos - match[1].length;
            const afterCursor = text.substring(cursorPos);
            const closeMatch = afterCursor.match(/^[^}]*\\}\\}/);
            const endPos = closeMatch ? cursorPos + closeMatch[0].length : cursorPos;
            
            input.value = text.substring(0, startPos) + value + '}}' + text.substring(endPos);
            input.selectionStart = input.selectionEnd = startPos + value.length + 2;
            
            // Trigger change event
            input.dispatchEvent(new Event('change'));
        }
        
        this.hideAutocomplete();
        input.focus();
    },
    
    // Hide autocomplete
    hideAutocomplete() {
        if (this.autocompleteDropdown) {
            this.autocompleteDropdown.style.display = 'none';
        }
    },
    
    // Delete current node
    deleteNode() {
        if (this.currentNode && this.currentNode.type !== 'start') {
            vscode.postMessage({
                type: 'deleteNode',
                payload: { nodeId: this.currentNode.id }
            });
        }
    },
    
    // Delete all selected nodes
    deleteSelectedNodes() {
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
    },
    
    // Parameter management
    addParameter() {
        if (!GraphState.graph) return;
        if (!GraphState.graph.parameters) GraphState.graph.parameters = [];
        
        GraphState.graph.parameters.push({
            name: 'param_' + GraphState.graph.parameters.length,
            type: 'string',
            required: false
        });
        
        this.renderEmpty();
        this.notifyGraphUpdate();
    },
    
    updateParameter(index, field, value) {
        if (GraphState.graph?.parameters?.[index]) {
            GraphState.graph.parameters[index][field] = value;
            this.notifyGraphUpdate();
        }
    },
    
    removeParameter(index) {
        if (GraphState.graph?.parameters) {
            GraphState.graph.parameters.splice(index, 1);
            this.renderEmpty();
            this.notifyGraphUpdate();
        }
    },
    
    // Variable management
    addVariable() {
        if (!GraphState.graph) return;
        if (!GraphState.graph.variables) GraphState.graph.variables = [];
        
        GraphState.graph.variables.push({
            id: 'var_' + GraphState.graph.variables.length,
            type: 'string',
            default: ''
        });
        
        this.renderEmpty();
        this.notifyGraphUpdate();
    },
    
    updateVariable(index, field, value) {
        if (GraphState.graph?.variables?.[index]) {
            GraphState.graph.variables[index][field] = value;
            this.notifyGraphUpdate();
        }
    },
    
    removeVariable(index) {
        if (GraphState.graph?.variables) {
            GraphState.graph.variables.splice(index, 1);
            this.renderEmpty();
            this.notifyGraphUpdate();
        }
    },
    
    notifyGraphUpdate() {
        vscode.postMessage({
            type: 'updateGraphMeta',
            payload: {
                parameters: GraphState.graph.parameters,
                variables: GraphState.graph.variables
            }
        });
    },
    
    // Utility
    escapeHtml(str) {
        if (typeof str !== 'string') return str;
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};
`;
}

