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
    description: 'Request an agent from the pool and allocate to a bench seat.',
    category: 'agent',
    icon: 'person-add',
    color: '#ec4899',
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
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues when agent is allocated'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'benchSeat',
                type: 'number',
                label: 'Allocate to Bench Seat',
                description: 'Which bench seat to allocate agent to (1-10)',
                required: true,
                defaultValue: 1,
                min: 1,
                max: 10
            },
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
    const benchSeat = node.config.benchSeat ?? 1;
    const role = node.config.role;
    const timeoutSeconds = node.config.timeoutSeconds ?? 300;
    const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
    
    if (!role) {
        throw new Error('Agent role is required');
    }
    
    context.log(`Requesting agent with role: ${role} for bench seat ${benchSeat} (timeout: ${timeoutSeconds}s)`, 'info');
    
    // Request agent with timeout - always waits for availability
    const agentName = await context.requestAgent(role, { timeoutMs });
    
    // Place agent on bench seat
    context.setAgentOnBench(benchSeat - 1, agentName); // 0-indexed internally
    
    context.log(`Agent allocated: ${agentName} -> bench seat ${benchSeat}`, 'info');
    
    return {
        done: true
    };
};

// ============================================================================
// Agentic Work Node
// ============================================================================

export const AgenticWorkNodeDefinition: INodeDefinition = {
    type: 'agentic_work',
    name: 'Agentic Work',
    description: 'Execute work with an agent from the bench using a custom prompt.',
    category: 'agent',
    icon: 'hubot',
    color: '#ec4899',
    defaultInputs: [
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
                name: 'benchSeat',
                type: 'number',
                label: 'Bench Seat',
                description: 'Which bench seat to use for agent (1-10)',
                required: true,
                defaultValue: 1,
                min: 1,
                max: 10
            },
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
    const benchSeat = node.config.benchSeat ?? 1;
    const agentName = context.getAgentFromBench(benchSeat - 1); // 0-indexed internally
    const promptTemplate = node.config.promptTemplate;
    const model = node.config.model;
    const releaseAfter = node.config.releaseAfter;
    const parseJson = node.config.parseJson;
    const stage = node.config.stage || 'implementation';
    
    if (!agentName) {
        throw new Error(`No agent found in bench seat ${benchSeat}`);
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
            context.removeAgentFromBench(benchSeat - 1);
            context.log(`Released agent: ${agentName}`, 'debug');
        }
        
        return {
            result: output,
            success: result.success,
            done: true
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        // Classify error for better diagnostics
        const { ErrorClassifier } = await import('../../ErrorClassifier');
        const { ServiceLocator } = await import('../../../ServiceLocator');
        const classifier = ServiceLocator.resolve(ErrorClassifier);
        const classification = classifier.classify(errorMsg);
        
        context.log(`Agent task failed: ${errorMsg}`, 'error');
        context.log(`  Error type: ${classification.type} (${classification.category}), Action: ${classification.suggestedAction}`, 'error');
        
        if (releaseAfter) {
            context.releaseAgent(agentName);
            context.removeAgentFromBench(benchSeat - 1);
        }
        
        return {
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
    description: 'Release an agent from a bench seat back to the pool.',
    category: 'agent',
    icon: 'person-remove',
    color: '#ec4899',
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
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after agent released'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'benchSeat',
                type: 'number',
                label: 'Release from Bench Seat',
                description: 'Which bench seat to release agent from (1-10)',
                required: true,
                defaultValue: 1,
                min: 1,
                max: 10
            }
        ]
    }
};

export const AgentReleaseNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const benchSeat = node.config.benchSeat ?? 1;
    const agentName = context.getAgentFromBench(benchSeat - 1); // 0-indexed internally
    
    if (!agentName) {
        throw new Error(`No agent found in bench seat ${benchSeat}`);
    }
    
    context.log(`Releasing agent from bench seat ${benchSeat}: ${agentName}`, 'info');
    context.releaseAgent(agentName);
    context.removeAgentFromBench(benchSeat - 1);
    
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
    description: 'Visual display of agents currently allocated to bench seats. Agents are assigned via Agent Request and released via Agent Release nodes.',
    category: 'agent',
    icon: 'people',
    color: '#ec4899',
    defaultInputs: [],
    defaultOutputs: [],
    allowDynamicPorts: false,
    configSchema: {
        fields: [
            {
                name: 'seatCount',
                type: 'number',
                label: 'Number of Seats',
                description: 'Number of agent seats to display',
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
    // Agent Bench is a visual-only node
    // It displays which agents are currently on the bench
    // No execution logic needed - agents are managed via context.setAgentOnBench/getAgentFromBench
    return {};
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

