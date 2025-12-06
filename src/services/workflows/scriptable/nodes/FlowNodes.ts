// ============================================================================
// Flow Nodes - Start and End nodes for workflow execution
// ============================================================================

import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Start Node
// ============================================================================

export const StartNodeDefinition: INodeDefinition = {
    type: 'start',
    name: 'Start',
    description: 'Entry point for the workflow. Receives input data and triggers execution.',
    category: 'flow',
    icon: 'play',
    color: '#4CAF50',
    defaultInputs: [],
    defaultOutputs: [
        {
            id: 'output',
            name: 'Output',
            dataType: 'object',
            description: 'Workflow input data passed at dispatch'
        },
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        }
    ],
    minInstances: 1,
    maxInstances: 1
};

export const StartNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    context.log('Workflow started', 'info');
    
    // The input data comes from the workflow dispatch parameters
    // It's injected by the execution engine
    const workflowInput = inputs['__workflow_input__'] || {};
    
    return {
        output: workflowInput,
        trigger: true
    };
};

// ============================================================================
// End Node
// ============================================================================

export const EndNodeDefinition: INodeDefinition = {
    type: 'end',
    name: 'End',
    description: 'Exit point for the workflow. Collects output data.',
    category: 'flow',
    icon: 'stop',
    color: '#f44336',
    defaultInputs: [
        {
            id: 'input',
            name: 'Input',
            dataType: 'any',
            description: 'Data to output from the workflow'
        },
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        }
    ],
    defaultOutputs: [],
    configSchema: {
        fields: [
            {
                name: 'outputKey',
                type: 'string',
                label: 'Output Key',
                description: 'Key name for the output data (default: result)',
                defaultValue: 'result'
            },
            {
                name: 'success',
                type: 'boolean',
                label: 'Mark Success',
                description: 'Whether reaching this end node indicates success',
                defaultValue: true
            }
        ]
    },
    minInstances: 1
};

export const EndNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const outputKey = node.config.outputKey || 'result';
    const success = node.config.success !== false;
    
    context.log(`Workflow ended (success: ${success})`, 'info');
    
    // Return the output with metadata for the workflow
    return {
        __workflow_output__: {
            [outputKey]: inputs.input,
            success
        }
    };
};

// ============================================================================
// Registration
// ============================================================================

export function registerFlowNodes(): void {
    nodeRegistry.register(StartNodeDefinition, StartNodeExecutor);
    nodeRegistry.register(EndNodeDefinition, EndNodeExecutor);
}

