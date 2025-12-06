// ============================================================================
// Data Nodes - Knowledge, Context, Variable, Subgraph nodes
// ============================================================================

import * as path from 'path';
import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Knowledge Node
// ============================================================================

export const KnowledgeNodeDefinition: INodeDefinition = {
    type: 'knowledge',
    name: 'Knowledge',
    description: 'Load documentation or knowledge file content',
    category: 'data',
    icon: 'book',
    color: '#3F51B5',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        }
    ],
    defaultOutputs: [
        {
            id: 'content',
            name: 'Content',
            dataType: 'string',
            description: 'File content'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after file loaded'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'filePath',
                type: 'string',
                label: 'File Path',
                description: 'Path to the documentation file (relative to workspace)',
                required: true
            },
            {
                name: 'encoding',
                type: 'select',
                label: 'Encoding',
                description: 'File encoding',
                options: [
                    { value: 'utf-8', label: 'UTF-8' },
                    { value: 'utf-16', label: 'UTF-16' },
                    { value: 'ascii', label: 'ASCII' }
                ],
                defaultValue: 'utf-8'
            }
        ]
    }
};

export const KnowledgeNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const filePath = node.config.filePath;
    
    if (!filePath) {
        throw new Error('File path is required');
    }
    
    const resolvedPath = context.renderTemplate(filePath);
    
    context.log(`Loading knowledge file: ${resolvedPath}`, 'debug');
    
    try {
        const content = await context.readFile(resolvedPath);
        
        return {
            content,
            done: true
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read knowledge file: ${errorMsg}`);
    }
};

// ============================================================================
// Context Node
// ============================================================================

export const ContextNodeDefinition: INodeDefinition = {
    type: 'context',
    name: 'Context',
    description: 'Load context from the _AiDevLog/Context folder',
    category: 'data',
    icon: 'file-text',
    color: '#00BCD4',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        }
    ],
    defaultOutputs: [
        {
            id: 'content',
            name: 'Content',
            dataType: 'string',
            description: 'Context file content'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after context loaded'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'contextName',
                type: 'string',
                label: 'Context Name',
                description: 'Name of the context file (without .md extension)',
                required: true
            },
            {
                name: 'fallbackContent',
                type: 'multiline',
                label: 'Fallback Content (Use with Caution)',
                description: 'Content to use if context file does not exist. WARNING: Using fallback content masks missing file errors. Only use if missing context is acceptable.'
            }
        ]
    }
};

export const ContextNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const contextName = node.config.contextName;
    const fallbackContent = node.config.fallbackContent || '';
    
    if (!contextName) {
        throw new Error('Context name is required');
    }
    
    const resolvedName = context.renderTemplate(contextName);
    const contextPath = path.join('_AiDevLog', 'Context', `${resolvedName}.md`);
    
    context.log(`Loading context: ${resolvedName}`, 'debug');
    
    try {
        const content = await context.readFile(contextPath);
        return {
            content,
            done: true
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        // Only use fallback if explicitly configured
        if (fallbackContent) {
            context.log(
                `Context file '${contextPath}' not found. Using fallback content. ` +
                `WARNING: This masks the missing file error. Error: ${errorMsg}`,
                'error'
            );
            return {
                content: fallbackContent,
                done: true
            };
        }
        
        // No fallback configured - fail explicitly
        throw new Error(
            `Context file '${contextPath}' not found and no fallback content configured. ` +
            `Please create the context file or configure fallback content. Original error: ${errorMsg}`
        );
    }
};

// ============================================================================
// Variable Node
// ============================================================================

export const VariableNodeDefinition: INodeDefinition = {
    type: 'variable',
    name: 'Variable',
    description: 'Get or set a workflow variable',
    category: 'data',
    icon: 'symbol-variable',
    color: '#8BC34A',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'set_value',
            name: 'Set Value',
            dataType: 'any',
            description: 'Value to set (for write mode)'
        }
    ],
    defaultOutputs: [
        {
            id: 'result',
            name: 'Result',
            dataType: 'any',
            description: 'Variable value'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after variable access'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'variableId',
                type: 'string',
                label: 'Variable ID',
                description: 'ID of the workflow variable',
                required: true
            },
            {
                name: 'mode',
                type: 'select',
                label: 'Mode',
                description: 'Read or write the variable',
                options: [
                    { value: 'read', label: 'Read' },
                    { value: 'write', label: 'Write' },
                    { value: 'readWrite', label: 'Read then Write' }
                ],
                defaultValue: 'read'
            },
            {
                name: 'expression',
                type: 'expression',
                label: 'Value Expression',
                description: 'Expression to evaluate for the new value (write mode)'
            }
        ]
    }
};

export const VariableNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const variableId = node.config.variableId;
    const mode = node.config.mode || 'read';
    const expression = node.config.expression;
    
    if (!variableId) {
        throw new Error('Variable ID is required');
    }
    
    let currentValue = context.getVariable(variableId);
    
    if (mode === 'write' || mode === 'readWrite') {
        let newValue: any;
        
        if (inputs.set_value !== undefined) {
            newValue = inputs.set_value;
        } else if (expression) {
            newValue = context.evaluate(expression);
        } else {
            throw new Error('Value or expression is required for write mode');
        }
        
        context.setVariable(variableId, newValue);
        context.log(`Variable ${variableId} set to: ${JSON.stringify(newValue)}`, 'debug');
        
        if (mode === 'write') {
            currentValue = newValue;
        }
    }
    
    return {
        result: currentValue,
        done: true
    };
};

// ============================================================================
// Subgraph Node
// ============================================================================

export const SubgraphNodeDefinition: INodeDefinition = {
    type: 'subgraph',
    name: 'Subgraph',
    description: 'Execute another workflow as a sub-workflow',
    category: 'data',
    icon: 'git-merge',
    color: '#673AB7',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'input',
            name: 'Input',
            dataType: 'object',
            description: 'Input data for the subgraph'
        }
    ],
    defaultOutputs: [
        {
            id: 'output',
            name: 'Output',
            dataType: 'any',
            description: 'Subgraph output'
        },
        {
            id: 'success',
            name: 'Success',
            dataType: 'boolean',
            description: 'Whether subgraph completed successfully'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after subgraph completes'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'graphPath',
                type: 'string',
                label: 'Graph Path',
                description: 'Path to the subgraph YAML file (relative to _AiDevLog/Workflows)',
                required: true
            },
            {
                name: 'inheritVariables',
                type: 'boolean',
                label: 'Inherit Variables',
                description: 'Pass parent workflow variables to subgraph',
                defaultValue: false
            }
        ]
    }
};

export const SubgraphNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const graphPath = node.config.graphPath;
    
    if (!graphPath) {
        throw new Error('Graph path is required');
    }
    
    // Subgraph execution will be handled by the NodeExecutionEngine
    // This executor just sets up the data for the engine to process
    context.log(`Subgraph node: ${graphPath} - execution delegated to engine`, 'debug');
    
    // Return a marker that tells the engine to execute the subgraph
    return {
        __subgraph__: {
            path: graphPath,
            input: inputs.input,
            inheritVariables: node.config.inheritVariables
        },
        success: true,
        done: true
    };
};

// ============================================================================
// Registration
// ============================================================================

export function registerDataNodes(): void {
    nodeRegistry.register(KnowledgeNodeDefinition, KnowledgeNodeExecutor);
    nodeRegistry.register(ContextNodeDefinition, ContextNodeExecutor);
    nodeRegistry.register(VariableNodeDefinition, VariableNodeExecutor);
    nodeRegistry.register(SubgraphNodeDefinition, SubgraphNodeExecutor);
}

