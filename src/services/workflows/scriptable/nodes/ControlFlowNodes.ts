// ============================================================================
// Control Flow Nodes - If, Switch, For, While nodes
// ============================================================================

import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// If Condition Node
// ============================================================================

export const IfConditionNodeDefinition: INodeDefinition = {
    type: 'if_condition',
    name: 'If Condition',
    description: 'Branch execution based on a condition',
    category: 'flow',
    icon: 'if-else',
    color: '#FF5722',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'value',
            name: 'Value',
            dataType: 'any',
            description: 'Value to evaluate in condition'
        }
    ],
    defaultOutputs: [
        {
            id: 'true',
            name: 'True',
            dataType: 'trigger',
            description: 'Triggered when condition is true'
        },
        {
            id: 'false',
            name: 'False',
            dataType: 'trigger',
            description: 'Triggered when condition is false'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'condition',
                type: 'expression',
                label: 'Condition',
                description: 'Expression that evaluates to true/false (e.g., value > 10, result.success == true)',
                required: true
            }
        ]
    }
};

export const IfConditionNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const condition = node.config.condition;
    
    if (!condition) {
        throw new Error('Condition is required');
    }
    
    // Make input value available in the expression context
    let result: boolean;
    try {
        // If there's a value input, make it available as 'value' in the expression
        if (inputs.value !== undefined) {
            context.setVariable('__if_value__', inputs.value);
        }
        result = Boolean(context.evaluate(condition));
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Condition evaluation failed: ${errorMsg}`);
    }
    
    context.log(`If condition evaluated to: ${result}`, 'debug');
    
    // Return which branch to take
    return {
        true: result ? true : undefined,
        false: !result ? true : undefined,
        __branch__: result ? 'true' : 'false'
    };
};

// ============================================================================
// Switch Case Node
// ============================================================================

export const SwitchCaseNodeDefinition: INodeDefinition = {
    type: 'switch_case',
    name: 'Switch Case',
    description: 'Multi-way branch based on value matching',
    category: 'flow',
    icon: 'signpost',
    color: '#FF5722',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'value',
            name: 'Value',
            dataType: 'any',
            description: 'Value to match against cases',
            required: true
        }
    ],
    defaultOutputs: [
        {
            id: 'case_0',
            name: 'Case 0',
            dataType: 'trigger',
            description: 'First case'
        },
        {
            id: 'case_1',
            name: 'Case 1',
            dataType: 'trigger',
            description: 'Second case'
        },
        {
            id: 'default',
            name: 'Default',
            dataType: 'trigger',
            description: 'Default case (no match)'
        }
    ],
    allowDynamicPorts: true,
    configSchema: {
        fields: [
            {
                name: 'cases',
                type: 'multiline',
                label: 'Cases (JSON)',
                description: 'JSON array of case values: ["value1", "value2", ...]',
                required: true,
                defaultValue: '["case1", "case2"]'
            },
            {
                name: 'useExpression',
                type: 'boolean',
                label: 'Use Expression',
                description: 'Evaluate value as expression instead of literal match',
                defaultValue: false
            }
        ]
    }
};

export const SwitchCaseNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const value = inputs.value;
    let cases: any[];
    
    try {
        cases = JSON.parse(node.config.cases || '[]');
    } catch {
        throw new Error('Invalid cases JSON array');
    }
    
    context.log(`Switch on value: ${JSON.stringify(value)}`, 'debug');
    
    // Find matching case
    const matchIndex = cases.findIndex(caseValue => {
        if (node.config.useExpression) {
            return context.evaluate(`(${value}) == (${caseValue})`);
        }
        return value === caseValue;
    });
    
    // Build output object
    const outputs: Record<string, any> = {};
    
    if (matchIndex >= 0) {
        outputs[`case_${matchIndex}`] = true;
        outputs.__branch__ = `case_${matchIndex}`;
        context.log(`Switch matched case ${matchIndex}: ${cases[matchIndex]}`, 'debug');
    } else {
        outputs.default = true;
        outputs.__branch__ = 'default';
        context.log(`Switch: no match, using default`, 'debug');
    }
    
    return outputs;
};

// ============================================================================
// For Loop Node (Container style)
// ============================================================================

export const ForLoopNodeDefinition: INodeDefinition = {
    type: 'for_loop',
    name: 'For Loop',
    description: 'Container loop node - drag nodes inside to form the loop body',
    category: 'flow',
    icon: 'loop',
    color: '#009688',
    // External ports (on the outer frame)
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Starts the loop'
        },
        {
            id: 'items',
            name: 'Items',
            dataType: 'array',
            description: 'Array to iterate over'
        }
    ],
    defaultOutputs: [
        {
            id: 'complete',
            name: 'Complete',
            dataType: 'trigger',
            description: 'Triggers when loop finishes'
        },
        {
            id: 'results',
            name: 'Results',
            dataType: 'array',
            description: 'Collected results from all iterations'
        }
    ],
    // Mark as container node
    allowDynamicPorts: false,
    configSchema: {
        fields: [
            {
                name: 'mode',
                type: 'select',
                label: 'Mode',
                description: 'Loop mode',
                options: [
                    { value: 'array', label: 'Iterate Array' },
                    { value: 'range', label: 'Range (start to end)' },
                    { value: 'count', label: 'Count (0 to n-1)' }
                ],
                defaultValue: 'array'
            },
            {
                name: 'start',
                type: 'number',
                label: 'Start',
                description: 'Start value for range mode',
                defaultValue: 0
            },
            {
                name: 'end',
                type: 'number',
                label: 'End',
                description: 'End value for range mode',
                defaultValue: 10
            },
            {
                name: 'count',
                type: 'number',
                label: 'Count',
                description: 'Number of iterations for count mode',
                defaultValue: 5
            },
            {
                name: 'width',
                type: 'number',
                label: 'Width (px)',
                description: 'Width of the loop container',
                defaultValue: 400,
                min: 250,
                max: 1200
            },
            {
                name: 'height',
                type: 'number',
                label: 'Height (px)',
                description: 'Height of the loop container',
                defaultValue: 250,
                min: 150,
                max: 800
            },
            {
                name: 'containedNodeIds',
                type: 'string',
                label: 'Contained Nodes',
                description: 'Comma-separated list of node IDs in loop body (auto-managed)',
                defaultValue: ''
            }
        ]
    },
    // Internal ports (rendered inside the container) - stored separately
    internalPorts: {
        outputs: [
            {
                id: 'loop_body',
                name: 'Loop Body',
                dataType: 'trigger',
                description: 'Triggers for each iteration - connect to nodes inside the loop'
            },
            {
                id: 'item',
                name: 'Current Item',
                dataType: 'any',
                description: 'Current iteration item'
            },
            {
                id: 'index',
                name: 'Index',
                dataType: 'number',
                description: 'Current iteration index'
            }
        ],
        inputs: [
            {
                id: 'loop_back',
                name: 'Loop Back',
                dataType: 'trigger',
                description: 'Connect from loop body end to continue to next iteration'
            }
        ]
    }
};

export const ForLoopNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const mode = node.config.mode || 'array';
    let items: any[];
    
    switch (mode) {
        case 'array':
            items = Array.isArray(inputs.items) ? inputs.items : [];
            break;
        case 'range':
            const start = node.config.start || 0;
            const end = node.config.end || 10;
            items = Array.from({ length: end - start }, (_, i) => start + i);
            break;
        case 'count':
            const count = node.config.count || 5;
            items = Array.from({ length: count }, (_, i) => i);
            break;
        default:
            items = [];
    }
    
    context.log(`For loop: ${items.length} iterations`, 'debug');
    
    // Return loop metadata - actual iteration is handled by the execution engine
    return {
        __loop__: {
            type: 'for',
            items,
            currentIndex: 0
        },
        // Internal outputs (inside loop container)
        loop_body: items.length > 0,
        item: items[0],
        index: 0,
        // External outputs (outside loop container)
        complete: items.length === 0,
        results: []
    };
};

// ============================================================================
// Registration
// ============================================================================

export function registerControlFlowNodes(): void {
    nodeRegistry.register(IfConditionNodeDefinition, IfConditionNodeExecutor);
    nodeRegistry.register(SwitchCaseNodeDefinition, SwitchCaseNodeExecutor);
    nodeRegistry.register(ForLoopNodeDefinition, ForLoopNodeExecutor);
}

