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
    icon: 'split-branch',
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
    icon: 'switch',
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
// For Loop Node
// ============================================================================

export const ForLoopNodeDefinition: INodeDefinition = {
    type: 'for_loop',
    name: 'For Loop',
    description: 'Iterate over an array or range',
    category: 'flow',
    icon: 'loop',
    color: '#009688',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Starts the loop'
        },
        {
            id: 'loop_back',
            name: 'Loop Back',
            dataType: 'trigger',
            description: 'Connect from loop body to continue to next iteration'
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
        },
        {
            id: 'loop',
            name: 'Loop Body',
            dataType: 'trigger',
            description: 'Triggers for each iteration'
        },
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
        item: items[0],
        index: 0,
        loop: items.length > 0,
        complete: items.length === 0,
        results: []
    };
};

// ============================================================================
// While Loop Node
// ============================================================================

export const WhileLoopNodeDefinition: INodeDefinition = {
    type: 'while_loop',
    name: 'While Loop',
    description: 'Loop while a condition is true',
    category: 'flow',
    icon: 'repeat',
    color: '#009688',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Starts the loop'
        },
        {
            id: 'loop_back',
            name: 'Loop Back',
            dataType: 'trigger',
            description: 'Connect from loop body to continue to next iteration'
        }
    ],
    defaultOutputs: [
        {
            id: 'iteration',
            name: 'Iteration',
            dataType: 'number',
            description: 'Current iteration count'
        },
        {
            id: 'loop',
            name: 'Loop Body',
            dataType: 'trigger',
            description: 'Triggers while condition is true'
        },
        {
            id: 'complete',
            name: 'Complete',
            dataType: 'trigger',
            description: 'Triggers when condition becomes false'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'condition',
                type: 'expression',
                label: 'Condition',
                description: 'Loop continues while this expression is true',
                required: true
            },
            {
                name: 'maxIterations',
                type: 'number',
                label: 'Max Iterations',
                description: 'Safety limit for maximum iterations',
                defaultValue: 100,
                min: 1,
                max: 10000
            }
        ]
    }
};

export const WhileLoopNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const condition = node.config.condition;
    const maxIterations = node.config.maxIterations || 100;
    
    if (!condition) {
        throw new Error('Condition is required');
    }
    
    // Evaluate initial condition
    let result: boolean;
    try {
        result = Boolean(context.evaluate(condition));
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Condition evaluation failed: ${errorMsg}`);
    }
    
    context.log(`While loop: condition = ${result}`, 'debug');
    
    // Return loop metadata - actual iteration is handled by the execution engine
    return {
        __loop__: {
            type: 'while',
            condition,
            maxIterations,
            currentIteration: 0
        },
        iteration: 0,
        loop: result,
        complete: !result
    };
};

// ============================================================================
// Registration
// ============================================================================

export function registerControlFlowNodes(): void {
    nodeRegistry.register(IfConditionNodeDefinition, IfConditionNodeExecutor);
    nodeRegistry.register(SwitchCaseNodeDefinition, SwitchCaseNodeExecutor);
    nodeRegistry.register(ForLoopNodeDefinition, ForLoopNodeExecutor);
    nodeRegistry.register(WhileLoopNodeDefinition, WhileLoopNodeExecutor);
}

