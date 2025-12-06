// ============================================================================
// Script Node - Execute user-defined JavaScript in a sandboxed environment
// ============================================================================

import * as vm from 'vm';
import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Script Node Definition
// ============================================================================

export const ScriptNodeDefinition: INodeDefinition = {
    type: 'script',
    name: 'Script',
    description: 'Execute custom JavaScript code with access to workflow context',
    category: 'data',
    icon: 'code',
    color: '#9C27B0',
    defaultInputs: [
        {
            id: 'trigger',
            name: 'Trigger',
            dataType: 'trigger',
            description: 'Execution flow trigger'
        },
        {
            id: 'inputData',
            name: 'Input Data',
            dataType: 'any',
            description: 'Data available as inputData in script'
        }
    ],
    defaultOutputs: [
        {
            id: 'result',
            name: 'Result',
            dataType: 'any',
            description: 'Script return value'
        },
        {
            id: 'done',
            name: 'Done',
            dataType: 'trigger',
            description: 'Execution flow continues after script'
        }
    ],
    configSchema: {
        fields: [
            {
                name: 'script',
                type: 'multiline',
                label: 'Script',
                description: 'JavaScript code to execute. Return an object with output port values.',
                required: true
            },
            {
                name: 'timeout',
                type: 'number',
                label: 'Timeout (ms)',
                description: 'Script execution timeout in milliseconds',
                defaultValue: 5000,
                min: 100,
                max: 60000
            }
        ]
    }
};

// ============================================================================
// Script Node Executor
// ============================================================================

export const ScriptNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    const script = node.config.script;
    
    if (!script || typeof script !== 'string') {
        throw new Error('Script is required and must be a string');
    }
    
    const timeout = node.config.timeout || 5000;
    
    context.log('Executing script node', 'debug');
    
    // Create a sandboxed context with limited access
    const sandbox = {
        // Input data
        inputData: inputs.inputData || inputs,
        
        // Context access (limited)
        context: {
            getVariable: (id: string) => context.getVariable(id),
            setVariable: (id: string, value: any) => context.setVariable(id, value),
            getParameter: (name: string) => context.getParameter(name),
            evaluate: (expr: string) => context.evaluate(expr),
            renderTemplate: (template: string) => context.renderTemplate(template)
        },
        
        // Logging
        log: (message: string, level?: string) => {
            context.log(`[Script] ${message}`, level as any || 'info');
        },
        
        // Safe built-ins
        console: {
            log: (...args: any[]) => context.log(`[Script] ${args.join(' ')}`, 'info'),
            warn: (...args: any[]) => context.log(`[Script] ${args.join(' ')}`, 'warn'),
            error: (...args: any[]) => context.log(`[Script] ${args.join(' ')}`, 'error'),
            debug: (...args: any[]) => context.log(`[Script] ${args.join(' ')}`, 'debug')
        },
        JSON: {
            parse: JSON.parse,
            stringify: JSON.stringify
        },
        Math,
        Date,
        Array: {
            isArray: Array.isArray,
            from: Array.from
        },
        Object: {
            keys: Object.keys,
            values: Object.values,
            entries: Object.entries,
            assign: Object.assign
        },
        String,
        Number,
        Boolean,
        
        // Result placeholder
        __result: undefined
    };
    
    try {
        // Wrap script to capture return value
        const wrappedScript = `
            (function() {
                'use strict';
                ${script}
            })();
        `;
        
        // Create sandboxed VM context
        const vmContext = vm.createContext(sandbox);
        
        // Execute with timeout
        const result = vm.runInContext(wrappedScript, vmContext, {
            timeout,
            displayErrors: true,
            breakOnSigint: true
        });
        
        context.log('Script executed successfully', 'debug');
        
        // Result should be an object with output port values
        if (result && typeof result === 'object') {
            return {
                ...result,
                done: true
            };
        }
        
        // If result is not an object, return it as 'result' output
        return {
            result,
            done: true
        };
        
    } catch (error: any) {
        const message = error.message || String(error);
        context.log(`Script execution failed: ${message}`, 'error');
        
        // Include stack trace if available
        if (error.stack) {
            context.log(`Stack trace: ${error.stack}`, 'debug');
        }
        
        throw new Error(`Script execution failed: ${message}`);
    }
};

// ============================================================================
// Registration
// ============================================================================

export function registerScriptNode(): void {
    nodeRegistry.register(ScriptNodeDefinition, ScriptNodeExecutor);
}

