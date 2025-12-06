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
    description: 'Request an agent from the pool and allocate it to the workflow bench.',
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
            description: 'Allocated agent reference'
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
                type: 'string',
                label: 'Agent Role',
                description: 'Role ID for the agent (e.g., engineer, analyst, code_reviewer)',
                required: true
            },
            {
                name: 'waitForAvailable',
                type: 'boolean',
                label: 'Wait for Available',
                description: 'If true, wait until an agent is available. If false, fail immediately if none available.',
                defaultValue: true
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
    
    if (!role) {
        throw new Error('Agent role is required');
    }
    
    context.log(`Requesting agent with role: ${role}`, 'info');
    
    const agentName = await context.requestAgent(role);
    
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
            required: true
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
    
    if (!agentName) {
        throw new Error('Agent reference is required');
    }
    
    if (!promptTemplate) {
        throw new Error('Prompt template is required');
    }
    
    // Render the prompt template with context
    const prompt = context.renderTemplate(promptTemplate);
    
    context.log(`Running agent task with ${agentName}`, 'info');
    
    try {
        const result = await context.runAgentTask(agentName, prompt, {
            model,
            timeoutMs: node.timeoutMs
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
            result: errorMsg,
            success: false,
            done: true
        };
    }
};

// ============================================================================
// Registration
// ============================================================================

export function registerAgentNodes(): void {
    nodeRegistry.register(AgentRequestNodeDefinition, AgentRequestNodeExecutor);
    nodeRegistry.register(AgenticWorkNodeDefinition, AgenticWorkNodeExecutor);
}

