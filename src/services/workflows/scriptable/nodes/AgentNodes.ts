// ============================================================================
// Agent Nodes - Nodes for agent allocation and task execution
// ============================================================================

import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Agent Request Node
// ============================================================================

export const AgentRequestNodeDefinition: INodeDefinition = {
    type: 'agent_request',
    name: 'Agent Request',
    description: 'Request an agent from the pool. Waits until an agent is available or times out.',
    category: 'agent',
    icon: 'person-add',
    color: '#2196F3',
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
            id: 'agent',
            name: 'Agent',
            dataType: 'agent',
            description: 'Allocated agent reference',
            allowMultiple: false
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues when agent is allocated'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'role',
                type: 'select',
                label: 'Agent Role',
                description: 'Role for the agent to fulfill',
                required: true,
                dynamicOptions: 'agentRoles', // Options fetched dynamically from AgentRoleRegistry
                defaultValue: 'engineer'
            },
            {
                name: 'timeoutSeconds',
                type: 'number',
                label: 'Timeout (seconds)',
                description: 'Maximum time to wait for an agent. 0 = no timeout.',
                defaultValue: 300,
                min: 0,
                max: 3600
            }
        ]
    }
};

export const AgentRequestNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const role = node.config.role;
    const timeoutSeconds = node.config.timeoutSeconds ?? 300;
    const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
    
    if (!role) {
        throw new Error('Agent role is required');
    }
    
    context.log(`Requesting agent with role: ${role} (timeout: ${timeoutSeconds}s)`, 'info');
    
    // Request agent with timeout - always waits for availability
    const agentName = await context.requestAgent(role, { timeoutMs });
    
    context.log(`Agent allocated: ${agentName}`, 'info');
    
    return {
        agent: agentName,
        done: true
    };
};

// ============================================================================
// Agentic Work Node
// ============================================================================

export const AgenticWorkNodeDefinition: INodeDefinition = {
    type: 'agentic_work',
    name: 'Agentic Work',
    description: 'Execute work with an agent using a custom prompt.',
    category: 'agent',
    icon: 'hubot',
    color: '#9C27B0',
    defaultInputs: [
        {
            id: 'agent',
            name: 'Agent',
            dataType: 'agent',
            description: 'Agent reference (from Agent Request node)',
            required: true,
            allowMultiple: false
        },
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'context',
            name: 'Context',
            dataType: 'any',
            description: 'Additional context data to inject into prompt'
        }
    ],
    defaultOutputs: [
        {
            id: 'agent_out',
            name: 'Agent',
            dataType: 'agent',
            description: 'Agent reference (pass to bench, release, or next work node)',
            allowMultiple: false
        },
        {
            id: 'result',
            name: 'Result',
            dataType: 'string',
            description: 'Agent output/response'
        },
        {
            id: 'success',
            name: 'Success',
            dataType: 'boolean',
            description: 'Whether the agent task succeeded'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues when agent task completes'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'promptTemplate',
                type: 'template',
                label: 'Prompt Template',
                description: 'Prompt template with {{variable}} placeholders',
                required: true
            },
            {
                name: 'model',
                type: 'select',
                label: 'Model',
                description: 'AI model to use',
                options: [
                    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
                    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
                    { value: 'gpt-4o', label: 'GPT-4o' },
                    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' }
                ],
                defaultValue: 'claude-sonnet-4-20250514'
            },
            {
                name: 'releaseAfter',
                type: 'boolean',
                label: 'Release Agent After',
                description: 'Release the agent back to the pool after task completion',
                defaultValue: false
            },
            {
                name: 'parseJson',
                type: 'boolean',
                label: 'Parse JSON Response',
                description: 'Try to parse the agent response as JSON',
                defaultValue: false
            },
            {
                name: 'stage',
                type: 'select',
                label: 'CLI Callback Stage',
                description: 'Stage for CLI callback completion signal',
                options: [
                    { value: 'implementation', label: 'Implementation' },
                    { value: 'review', label: 'Review' },
                    { value: 'analysis', label: 'Analysis' },
                    { value: 'context', label: 'Context' },
                    { value: 'planning', label: 'Planning' },
                    { value: 'finalization', label: 'Finalization' }
                ],
                defaultValue: 'implementation'
            }
        ]
    }
};

export const AgenticWorkNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const agentName = inputs.agent;
    const promptTemplate = node.config.promptTemplate;
    const model = node.config.model;
    const releaseAfter = node.config.releaseAfter;
    const parseJson = node.config.parseJson;
    const stage = node.config.stage || 'implementation';
    
    if (!agentName) {
        throw new Error('Agent reference is required');
    }
    
    if (!promptTemplate) {
        throw new Error('Prompt template is required');
    }
    
    // Render the prompt template with context
    const prompt = context.renderTemplate(promptTemplate);
    
    context.log(`Running agent task with ${agentName} (stage: ${stage})`, 'info');
    
    try {
        const result = await context.runAgentTask(agentName, prompt, {
            model,
            timeoutMs: node.timeoutMs,
            stage
        });
        
        let output = result.output;
        
        // Try to parse JSON if requested
        if (parseJson && result.success) {
            try {
                // Look for JSON in the output (might be wrapped in markdown code blocks)
                const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) || 
                                 output.match(/(\{[\s\S]*\})/);
                if (jsonMatch) {
                    output = JSON.parse(jsonMatch[1].trim());
                }
            } catch {
                context.log('Failed to parse JSON response, returning raw output', 'warn');
            }
        }
        
        // Release agent if configured
        if (releaseAfter) {
            context.releaseAgent(agentName);
            context.log(`Released agent: ${agentName}`, 'debug');
        }
        
        return {
            agent_out: releaseAfter ? undefined : agentName, // Pass agent through (unless released)
            result: output,
            success: result.success,
            done: true
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        context.log(`Agent task failed: ${errorMsg}`, 'error');
        
        if (releaseAfter) {
            context.releaseAgent(agentName);
        }
        
        return {
            agent_out: releaseAfter ? undefined : agentName, // Pass agent through even on failure (unless released)
            result: errorMsg,
            success: false,
            done: true
        };
    }
};

// ============================================================================
// Agent Release Node
// ============================================================================

export const AgentReleaseNodeDefinition: INodeDefinition = {
    type: 'agent_release',
    name: 'Agent Release',
    description: 'Release an agent back to the pool after use.',
    category: 'agent',
    icon: 'person-remove',
    color: '#F44336',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'agent',
            name: 'Agent',
            dataType: 'agent',
            description: 'Agent reference to release',
            allowMultiple: false
        }
    ],
    defaultOutputs: [
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after agent released'
        }
    ],
    configSchema: {
        fields: []
    }
};

export const AgentReleaseNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const agentName = inputs.agent;
    
    if (!agentName) {
        throw new Error('Agent reference is required');
    }
    
    context.log(`Releasing agent: ${agentName}`, 'info');
    context.releaseAgent(agentName);
    
    return {
        done: true
    };
};

// ============================================================================
// Agent Bench Node - Holds agents ready for use in the workflow
// ============================================================================

export const AgentBenchNodeDefinition: INodeDefinition = {
    type: 'agent_bench',
    name: 'Agent Bench',
    description: 'Holds agents ready for use. Each seat provides an agent in/out port pair.',
    category: 'agent',
    icon: 'people',
    color: '#00897B',
    defaultInputs: [
        { id: 'agent_in_0', name: 'Seat 1 In', dataType: 'agent', description: 'Agent input for seat 1', allowMultiple: true },
        { id: 'agent_in_1', name: 'Seat 2 In', dataType: 'agent', description: 'Agent input for seat 2', allowMultiple: true },
        { id: 'agent_in_2', name: 'Seat 3 In', dataType: 'agent', description: 'Agent input for seat 3', allowMultiple: true }
    ],
    defaultOutputs: [
        { id: 'agent_out_0', name: 'Seat 1 Out', dataType: 'agent', description: 'Agent output for seat 1', allowMultiple: true },
        { id: 'agent_out_1', name: 'Seat 2 Out', dataType: 'agent', description: 'Agent output for seat 2', allowMultiple: true },
        { id: 'agent_out_2', name: 'Seat 3 Out', dataType: 'agent', description: 'Agent output for seat 3', allowMultiple: true }
    ],
    allowDynamicPorts: true,
    configSchema: {
        fields: [
            {
                name: 'seatCount',
                type: 'number',
                label: 'Number of Seats',
                description: 'Number of agent seats (each seat has an in/out port pair)',
                required: true,
                defaultValue: 3,
                min: 1,
                max: 10
            }
        ]
    }
};

export const AgentBenchNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    // Agent Bench is a passthrough node - agents flow in and out
    // It serves as a visual organizer for agent references
    const outputs: Record<string, any> = {};
    
    // Pass through each agent from input to corresponding output
    for (const [key, value] of Object.entries(inputs)) {
        if (key.startsWith('agent_in_')) {
            const seatIndex = key.replace('agent_in_', '');
            outputs[`agent_out_${seatIndex}`] = value;
        }
    }
    
    return outputs;
};

// ============================================================================
// Registration
// ============================================================================

export function registerAgentNodes(): void {
    nodeRegistry.register(AgentRequestNodeDefinition, AgentRequestNodeExecutor);
    nodeRegistry.register(AgenticWorkNodeDefinition, AgenticWorkNodeExecutor);
    nodeRegistry.register(AgentReleaseNodeDefinition, AgentReleaseNodeExecutor);
    nodeRegistry.register(AgentBenchNodeDefinition, AgentBenchNodeExecutor);
}

