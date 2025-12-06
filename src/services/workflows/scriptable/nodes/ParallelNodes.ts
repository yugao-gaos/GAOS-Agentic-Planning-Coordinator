// ============================================================================
// Parallel Nodes - Branch and Sync nodes for parallel execution
// ============================================================================

import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Branch Node - Split execution into parallel branches
// ============================================================================

export const BranchNodeDefinition: INodeDefinition = {
    type: 'branch',
    name: 'Branch',
    description: 'Split execution into multiple parallel branches (1 → N)',
    category: 'parallel',
    icon: 'git-branch',
    color: '#00BCD4',
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
            dataType: 'any',
            description: 'Data to pass to all branches'
        }
    ],
    defaultOutputs: [
        {
            id: 'out_0',
            name: 'Branch 0',
            dataType: 'trigger',
            description: 'First parallel branch'
        },
        {
            id: 'out_1',
            name: 'Branch 1',
            dataType: 'trigger',
            description: 'Second parallel branch'
        },
        {
            id: 'out_2',
            name: 'Branch 2',
            dataType: 'trigger',
            description: 'Third parallel branch'
        },
        {
            id: 'data',
            name: 'Data',
            dataType: 'any',
            description: 'Input data passed through',
            allowMultiple: true
        }
    ],
    allowDynamicPorts: true,
    configSchema: {
        fields: [
            {
                name: 'branchCount',
                type: 'number',
                label: 'Branch Count',
                description: 'Number of parallel branches',
                required: true,
                defaultValue: 3,
                min: 2,
                max: 20
            },
            {
                name: 'passData',
                type: 'boolean',
                label: 'Pass Input Data',
                description: 'Pass input data to each branch',
                defaultValue: true
            }
        ]
    }
};

export const BranchNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const branchCount = node.config.branchCount || 3;
    const passData = node.config.passData !== false;
    
    context.log(`Branching into ${branchCount} parallel paths`, 'info');
    
    // Build output object with triggers for each branch
    const outputs: Record<string, any> = {
        __parallel__: {
            type: 'branch',
            branchCount,
            branches: []
        }
    };
    
    // Create trigger outputs for each branch
    for (let i = 0; i < branchCount; i++) {
        outputs[`out_${i}`] = true;
        outputs.__parallel__.branches.push(`out_${i}`);
    }
    
    // Pass data to all branches if configured
    if (passData && inputs.input !== undefined) {
        outputs.data = inputs.input;
    }
    
    return outputs;
};

// ============================================================================
// Sync Node - Wait for all parallel branches to complete
// ============================================================================

export const SyncNodeDefinition: INodeDefinition = {
    type: 'sync',
    name: 'Sync',
    description: 'Wait for multiple parallel branches to complete (N → 1)',
    category: 'parallel',
    icon: 'git-merge',
    color: '#00BCD4',
    defaultInputs: [
        {
            id: 'in_0',
            name: 'Branch 0',
            dataType: 'any',
            description: 'Input from first branch'
        },
        {
            id: 'in_1',
            name: 'Branch 1',
            dataType: 'any',
            description: 'Input from second branch'
        },
        {
            id: 'in_2',
            name: 'Branch 2',
            dataType: 'any',
            description: 'Input from third branch'
        }
    ],
    defaultOutputs: [
        {
            id: 'results',
            name: 'Results',
            dataType: 'array',
            description: 'Array of results from all branches'
        },
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Triggered when all branches complete'
        }
    ],
    allowDynamicPorts: true,
    configSchema: {
        fields: [
            {
                name: 'inputCount',
                type: 'number',
                label: 'Input Count',
                description: 'Number of inputs to wait for',
                required: true,
                defaultValue: 3,
                min: 2,
                max: 20
            },
            {
                name: 'mode',
                type: 'select',
                label: 'Sync Mode',
                description: 'How to handle branch completion',
                options: [
                    { value: 'wait_all', label: 'Wait for All' },
                    { value: 'wait_any', label: 'Wait for Any (first)' },
                    { value: 'wait_n', label: 'Wait for N' }
                ],
                defaultValue: 'wait_all'
            },
            {
                name: 'waitCount',
                type: 'number',
                label: 'Wait Count',
                description: 'Number of branches to wait for (wait_n mode)',
                defaultValue: 1,
                min: 1
            },
            {
                name: 'timeout',
                type: 'number',
                label: 'Timeout (ms)',
                description: 'Maximum time to wait for branches (0 = no timeout)',
                defaultValue: 0,
                min: 0
            }
        ]
    }
};

export const SyncNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const inputCount = node.config.inputCount || 3;
    const mode = node.config.mode || 'wait_all';
    const waitCount = node.config.waitCount || 1;
    
    context.log(`Sync node: mode=${mode}, inputs=${inputCount}`, 'debug');
    
    // Collect results from all input ports
    const results: any[] = [];
    const receivedInputs: string[] = [];
    
    for (let i = 0; i < inputCount; i++) {
        const inputKey = `in_${i}`;
        if (inputs[inputKey] !== undefined) {
            results.push(inputs[inputKey]);
            receivedInputs.push(inputKey);
        }
    }
    
    context.log(`Sync received ${results.length}/${inputCount} inputs`, 'debug');
    
    // Check if we have enough inputs based on mode
    let canProceed = false;
    
    switch (mode) {
        case 'wait_all':
            canProceed = results.length >= inputCount;
            break;
        case 'wait_any':
            canProceed = results.length >= 1;
            break;
        case 'wait_n':
            canProceed = results.length >= waitCount;
            break;
    }
    
    // Return sync state - actual waiting is handled by the execution engine
    return {
        __sync__: {
            type: 'sync',
            mode,
            inputCount,
            waitCount,
            receivedCount: results.length,
            receivedInputs,
            canProceed
        },
        results,
        trigger: canProceed
    };
};

// ============================================================================
// Registration
// ============================================================================

export function registerParallelNodes(): void {
    nodeRegistry.register(BranchNodeDefinition, BranchNodeExecutor);
    nodeRegistry.register(SyncNodeDefinition, SyncNodeExecutor);
}

