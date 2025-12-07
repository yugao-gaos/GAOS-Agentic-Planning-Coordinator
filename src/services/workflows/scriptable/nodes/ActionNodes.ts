// ============================================================================
// Action Nodes - Event, Command, Delay, Log nodes
// ============================================================================

import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Event Node
// ============================================================================

export const EventNodeDefinition: INodeDefinition = {
    type: 'event',
    name: 'Event',
    description: 'Emit events or call system APIs (task state, agent management, file reading)',
    category: 'actions',
    icon: 'broadcast',
    color: '#FF9800',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'payload',
            name: 'Payload',
            dataType: 'any',
            description: 'Event payload data'
        }
    ],
    defaultOutputs: [
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after event'
        },
        {
            id: 'task_data',
            name: 'Task Data',
            dataType: 'object',
            description: 'Task state data (read_task_state)'
        },
        {
            id: 'agent_name',
            name: 'Agent Name',
            dataType: 'string',
            description: 'Agent name (request_agent_with_return)'
        },
        {
            id: 'content',
            name: 'Content',
            dataType: 'string',
            description: 'File content (read_plan_file/read_context_brief)'
        },
        {
            id: 'path',
            name: 'Path',
            dataType: 'string',
            description: 'File path (read_plan_file/read_context_brief)'
        },
        {
            id: 'success',
            name: 'Success',
            dataType: 'boolean',
            description: 'Operation success status'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'eventType',
                type: 'select',
                label: 'Event Type',
                description: 'Type of event to emit',
                required: true,
                options: [
                    { value: 'kill_orphan_processes', label: 'Kill Orphan Processes' },
                    { value: 'unity_compile', label: 'Unity Compile' },
                    { value: 'unity_test', label: 'Unity Run Tests' },
                    { value: 'coordinator_notify', label: 'Notify Coordinator' },
                    { value: 'read_task_state', label: 'Read Task State (System)' },
                    { value: 'request_agent_with_return', label: 'Request Agent (System)' },
                    { value: 'release_agent_call', label: 'Release Agent (System)' },
                    { value: 'demote_agent_to_bench', label: 'Demote Agent to Bench (System)' },
                    { value: 'read_plan_file', label: 'Read Plan File (System)' },
                    { value: 'read_context_brief', label: 'Read Context Brief (System)' },
                    { value: 'custom', label: 'Custom Event' }
                ]
            },
            {
                name: 'customEventType',
                type: 'string',
                label: 'Custom Event Type',
                description: 'Custom event type name (when Event Type is "custom")'
            },
            {
                name: 'waitForResult',
                type: 'boolean',
                label: 'Wait for Result',
                description: 'Wait for event processing to complete before continuing',
                defaultValue: false
            },
            {
                name: 'taskId',
                type: 'template',
                label: 'Task ID',
                description: 'Task ID (for read_task_state event)'
            },
            {
                name: 'role',
                type: 'template',
                label: 'Role',
                description: 'Agent role (for request_agent_with_return event)'
            },
            {
                name: 'agent_name',
                type: 'template',
                label: 'Agent Name',
                description: 'Agent name (for release_agent_call/demote_agent_to_bench)'
            },
            {
                name: 'session_id',
                type: 'template',
                label: 'Session ID',
                description: 'Session ID (for read_plan_file/read_context_brief events)'
            }
        ]
    }
};

export const EventNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    let eventType = node.config.eventType;
    
    if (eventType === 'custom') {
        eventType = node.config.customEventType;
        if (!eventType) {
            throw new Error('Custom event type is required');
        }
    }
    
    const payload = inputs.payload || node.config.payload;
    
    context.log(`Processing event: ${eventType}`, 'info');
    
    // Handle system event types that return data
    switch (eventType) {
        case 'read_task_state': {
            const taskId = node.config.taskId || payload?.taskId;
            if (!taskId) {
                throw new Error('task_id is required for read_task_state event');
            }
            const taskData = await (context as any).readTaskState(taskId);
            return {
                task_data: taskData,
                done: true
            };
        }
        
        case 'request_agent_with_return': {
            const role = node.config.role || payload?.role;
            if (!role) {
                throw new Error('role is required for request_agent_with_return event');
            }
            const agentName = await context.requestAgent(role);
            return {
                agent_name: agentName,
                success: true,
                done: true
            };
        }
        
        case 'release_agent_call': {
            const agentName = node.config.agent_name || payload?.agent_name;
            if (!agentName) {
                throw new Error('agent_name is required for release_agent_call event');
            }
            context.releaseAgent(agentName);
            return {
                success: true,
                done: true
            };
        }
        
        case 'demote_agent_to_bench': {
            const agentName = node.config.agent_name || payload?.agent_name;
            if (!agentName) {
                throw new Error('agent_name is required for demote_agent_to_bench event');
            }
            (context as any).demoteAgentToBench(agentName);
            return {
                success: true,
                done: true
            };
        }
        
        case 'read_plan_file': {
            const sessionId = node.config.session_id || payload?.session_id;
            if (!sessionId) {
                throw new Error('session_id is required for read_plan_file event');
            }
            const fileData = await (context as any).readPlanFile(sessionId);
            return {
                content: fileData.content,
                path: fileData.path,
                done: true
            };
        }
        
        case 'read_context_brief': {
            const sessionId = node.config.session_id || payload?.session_id;
            if (!sessionId) {
                throw new Error('session_id is required for read_context_brief event');
            }
            const fileData = await (context as any).readContextBrief(sessionId);
            return {
                content: fileData.content,
                path: fileData.path,
                done: true
            };
        }
        
        default: {
            // Standard fire-and-forget events
            if (node.config.waitForResult) {
                // Wait for event to be processed
                await context.waitForEvent(`${eventType}_complete`, node.timeoutMs || 60000);
            } else {
                context.emitEvent(eventType, payload);
            }
            
            return {
                done: true
            };
        }
    }
};

// ============================================================================
// Command Node
// ============================================================================

export const CommandNodeDefinition: INodeDefinition = {
    type: 'command',
    name: 'Command',
    description: 'Execute a CLI command and capture output',
    category: 'actions',
    icon: 'terminal',
    color: '#607D8B',
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
            id: 'stdout',
            name: 'Stdout',
            dataType: 'string',
            description: 'Standard output'
        },
        {
            id: 'stderr',
            name: 'Stderr',
            dataType: 'string',
            description: 'Standard error'
        },
        {
            id: 'exitCode',
            name: 'Exit Code',
            dataType: 'number',
            description: 'Process exit code'
        },
        {
            id: 'success',
            name: 'Success',
            dataType: 'boolean',
            description: 'Whether command succeeded (exit code 0)'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after command completes'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'command',
                type: 'template',
                label: 'Command',
                description: 'Command to execute (supports {{variable}} substitution)',
                required: true
            },
            {
                name: 'cwd',
                type: 'string',
                label: 'Working Directory',
                description: 'Working directory for command execution'
            },
            {
                name: 'failOnError',
                type: 'boolean',
                label: 'Fail on Error',
                description: 'Throw error if command fails (non-zero exit)',
                defaultValue: false
            }
        ]
    }
};

export const CommandNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const commandTemplate = node.config.command;
    
    if (!commandTemplate) {
        throw new Error('Command is required');
    }
    
    const command = context.renderTemplate(commandTemplate);
    const cwd = node.config.cwd ? context.renderTemplate(node.config.cwd) : undefined;
    
    context.log(`Executing command: ${command}`, 'info');
    
    const result = await context.executeCommand(command, {
        cwd,
        timeoutMs: node.timeoutMs
    });
    
    const success = result.exitCode === 0;
    
    if (!success && node.config.failOnError) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr}`);
    }
    
    context.log(`Command completed with exit code: ${result.exitCode}`, success ? 'info' : 'warn');
    
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        success,
        done: true
    };
};

// ============================================================================
// Delay Node
// ============================================================================

export const DelayNodeDefinition: INodeDefinition = {
    type: 'delay',
    name: 'Delay',
    description: 'Pause execution for a specified duration',
    category: 'actions',
    icon: 'watch',
    color: '#795548',
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
            description: 'Execution flow continues after delay'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'durationMs',
                type: 'number',
                label: 'Duration (ms)',
                description: 'Delay duration in milliseconds',
                required: true,
                defaultValue: 1000,
                min: 0,
                max: 3600000 // 1 hour max
            }
        ]
    }
};

export const DelayNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const durationMs = node.config.durationMs || 1000;
    
    context.log(`Delaying for ${durationMs}ms`, 'debug');
    
    await context.sleep(durationMs);
    
    return {
        done: true
    };
};

// ============================================================================
// Log Node
// ============================================================================

export const LogNodeDefinition: INodeDefinition = {
    type: 'log',
    name: 'Log',
    description: 'Log a message for debugging or monitoring',
    category: 'annotation',
    icon: 'output',
    color: '#9E9E9E',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'data',
            name: 'Data',
            dataType: 'any',
            description: 'Data to log'
        }
    ],
    defaultOutputs: [
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after logging'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'message',
                type: 'template',
                label: 'Message',
                description: 'Message template with {{variable}} placeholders',
                required: true
            },
            {
                name: 'level',
                type: 'select',
                label: 'Log Level',
                description: 'Logging level',
                options: [
                    { value: 'debug', label: 'Debug' },
                    { value: 'info', label: 'Info' },
                    { value: 'warn', label: 'Warning' },
                    { value: 'error', label: 'Error' }
                ],
                defaultValue: 'info'
            },
            {
                name: 'includeData',
                type: 'boolean',
                label: 'Include Data',
                description: 'Include the data input in the log',
                defaultValue: false
            }
        ]
    }
};

export const LogNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const messageTemplate = node.config.message || '';
    const level = node.config.level || 'info';
    const includeData = node.config.includeData;
    
    let message = context.renderTemplate(messageTemplate);
    
    if (includeData && inputs.data !== undefined) {
        const dataStr = typeof inputs.data === 'object' 
            ? JSON.stringify(inputs.data, null, 2)
            : String(inputs.data);
        message += `\nData: ${dataStr}`;
    }
    
    context.log(message, level as 'info' | 'warn' | 'error' | 'debug');
    
    return {
        done: true
    };
};

// ============================================================================
// Wait Event Node
// ============================================================================

export const WaitEventNodeDefinition: INodeDefinition = {
    type: 'wait_event',
    name: 'Wait Event',
    description: 'Pause execution until an external event is received',
    category: 'actions',
    icon: 'bell',
    color: '#E91E63',
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
            id: 'payload',
            name: 'Payload',
            dataType: 'any',
            description: 'Event payload data'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after event received'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'eventType',
                type: 'string',
                label: 'Event Type',
                description: 'Type of event to wait for',
                required: true
            },
            {
                name: 'timeoutMs',
                type: 'number',
                label: 'Timeout (ms)',
                description: 'Maximum time to wait (default: 1 hour)',
                defaultValue: 3600000,
                min: 1000
            }
        ]
    }
};

export const WaitEventNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const eventType = node.config.eventType;
    const timeoutMs = node.config.timeoutMs || 3600000;
    
    if (!eventType) {
        throw new Error('Event type is required');
    }
    
    context.log(`Waiting for event: ${eventType}`, 'info');
    
    const payload = await context.waitForEvent(eventType, timeoutMs);
    
    context.log(`Event received: ${eventType}`, 'info');
    
    return {
        payload,
        done: true
    };
};

// ============================================================================
// Registration
// ============================================================================

export function registerActionNodes(): void {
    nodeRegistry.register(EventNodeDefinition, EventNodeExecutor);
    nodeRegistry.register(CommandNodeDefinition, CommandNodeExecutor);
    nodeRegistry.register(DelayNodeDefinition, DelayNodeExecutor);
    nodeRegistry.register(LogNodeDefinition, LogNodeExecutor);
    nodeRegistry.register(WaitEventNodeDefinition, WaitEventNodeExecutor);
}

