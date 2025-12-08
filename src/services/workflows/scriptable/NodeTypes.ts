// ============================================================================
// NodeTypes - Core interfaces for the Scriptable Node Workflow System
// ============================================================================

/**
 * Supported data types for node ports
 */
export type PortDataType = 
    | 'any'
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array'
    | 'trigger'  // Execution flow (no data, just triggers next node)
    | 'agent';   // Agent reference

/**
 * Port direction
 */
export type PortDirection = 'input' | 'output';

/**
 * Node port definition - defines an input or output slot on a node
 */
export interface INodePort {
    /** Unique port ID within the node */
    id: string;
    
    /** Human-readable name */
    name: string;
    
    /** Port direction */
    direction: PortDirection;
    
    /** Data type for validation */
    dataType: PortDataType;
    
    /** Whether this port is required (for inputs) */
    required?: boolean;
    
    /** Default value if not connected (for inputs) */
    defaultValue?: any;
    
    /** Allow multiple connections (for outputs or array inputs) */
    allowMultiple?: boolean;
    
    /** Description for tooltip/documentation */
    description?: string;
}

/**
 * Connection between two node ports
 */
export interface INodeConnection {
    /** Unique connection ID */
    id: string;
    
    /** Source node ID */
    fromNodeId: string;
    
    /** Source port ID */
    fromPortId: string;
    
    /** Target node ID */
    toNodeId: string;
    
    /** Target port ID */
    toPortId: string;
    
    /** Reroute points for visual routing (optional) */
    reroutes?: { x: number; y: number }[];
}

/**
 * Error handling strategy for a node
 */
export type ErrorStrategy = 'retry' | 'skip' | 'abort' | 'goto';

/**
 * Per-node error handling configuration
 */
export interface INodeErrorConfig {
    /** Strategy when this node fails */
    strategy: ErrorStrategy;
    
    /** Max retries if strategy is 'retry' */
    maxRetries?: number;
    
    /** Delay between retries in ms */
    retryDelayMs?: number;
    
    /** Target node ID if strategy is 'goto' */
    gotoNodeId?: string;
    
    /** Default value to use if strategy is 'skip' */
    skipDefaultValue?: any;
}

/**
 * Node configuration from YAML
 */
export interface INodeConfig {
    /** Node-type-specific configuration */
    [key: string]: any;
}

/**
 * Node instance in a graph - runtime representation
 */
export interface INodeInstance {
    /** Unique node ID within the graph */
    id: string;
    
    /** Node type (e.g., 'start', 'agentic_work', 'if_condition') */
    type: string;
    
    /** Node configuration */
    config: INodeConfig;
    
    /** Input port definitions */
    inputs: INodePort[];
    
    /** Output port definitions */
    outputs: INodePort[];
    
    /** Per-node timeout in milliseconds */
    timeoutMs?: number;
    
    /** Error handling configuration */
    onError?: INodeErrorConfig;
    
    /** Whether to create a checkpoint after this node */
    checkpoint?: boolean;
    
    /** Position in editor (x, y) */
    position?: { x: number; y: number };
    
    /** Custom label override */
    label?: string;
}

/**
 * Node category for organization in editor palette
 */
export type NodeCategory = 
    | 'flow'
    | 'agent'
    | 'data'
    | 'actions'
    | 'annotation';

/**
 * Node definition - static metadata about a node type
 * Used by NodeRegistry to define what types of nodes exist
 */
export interface INodeDefinition {
    /** Unique node type identifier */
    type: string;
    
    /** Human-readable name */
    name: string;
    
    /** Description for documentation */
    description: string;
    
    /** Category for editor palette */
    category: NodeCategory;
    
    /** Icon name (VS Code codicon or custom) */
    icon?: string;
    
    /** Color for node header in editor */
    color?: string;
    
    /** Default input ports */
    defaultInputs: Omit<INodePort, 'direction'>[];
    
    /** Default output ports */
    defaultOutputs: Omit<INodePort, 'direction'>[];
    
    /** Configuration schema for validation */
    configSchema?: INodeConfigSchema;
    
    /** Whether this node can have dynamic ports (added at runtime) */
    allowDynamicPorts?: boolean;
    
    /** Minimum instances of this node in a graph (e.g., 1 for start) */
    minInstances?: number;
    
    /** Maximum instances of this node in a graph (e.g., 1 for start) */
    maxInstances?: number;
}

/**
 * Configuration field schema for node config validation
 */
export interface INodeConfigField {
    /** Field name */
    name: string;
    
    /** Field type */
    type: 'string' | 'number' | 'boolean' | 'select' | 'multiline' | 'expression' | 'template';
    
    /** Human-readable label */
    label: string;
    
    /** Description/help text */
    description?: string;
    
    /** Whether field is required */
    required?: boolean;
    
    /** Default value */
    defaultValue?: any;
    
    /** Options for 'select' type */
    options?: { value: any; label: string }[];
    
    /** Dynamic options key - options fetched at runtime (e.g., 'agentRoles') */
    dynamicOptions?: string;
    
    /** Validation pattern (regex) for strings */
    pattern?: string;
    
    /** Min value for numbers */
    min?: number;
    
    /** Max value for numbers */
    max?: number;
}

/**
 * Node configuration schema
 */
export interface INodeConfigSchema {
    fields: INodeConfigField[];
}

/**
 * Variable definition in a workflow
 */
export interface IWorkflowVariable {
    /** Variable ID (used in expressions) */
    id: string;
    
    /** Human-readable name */
    name?: string;
    
    /** Data type */
    type: PortDataType;
    
    /** Initial value */
    default?: any;
    
    /** Description */
    description?: string;
}

/**
 * Parameter definition for workflow
 */
export interface IWorkflowParameter {
    /** Parameter name (used in templates) */
    name: string;
    
    /** Data type */
    type: PortDataType;
    
    /** Whether parameter is required at dispatch */
    required?: boolean;
    
    /** Default value if not provided */
    default?: any;
    
    /** Description */
    description?: string;
}

/**
 * Complete workflow graph definition (parsed from YAML)
 */
export interface INodeGraph {
    /** Workflow name (becomes WorkflowType: custom:{name}) */
    name: string;
    
    /** Version string */
    version: string;
    
    /** Description for documentation and coordinator prompt */
    description: string;
    
    /** Workflow-level parameters (injected at dispatch) */
    parameters?: IWorkflowParameter[];
    
    /** Workflow variables (shared state) */
    variables?: IWorkflowVariable[];
    
    /** All nodes in the graph */
    nodes: INodeInstance[];
    
    /** All connections between nodes */
    connections: INodeConnection[];
    
    /** Metadata for the editor */
    editor?: {
        /** Canvas zoom level */
        zoom?: number;
        /** Canvas pan offset */
        panX?: number;
        panY?: number;
    };
    
    /** Coordinator prompt override */
    coordinatorPrompt?: string;
}

/**
 * Node execution status
 */
export type NodeExecutionStatus = 
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'waiting';  // For sync nodes waiting on branches

/**
 * Result of executing a single node
 */
export interface INodeExecutionResult {
    /** Node ID */
    nodeId: string;
    
    /** Execution status */
    status: NodeExecutionStatus;
    
    /** Output values by port ID */
    outputs: Record<string, any>;
    
    /** Error message if failed */
    error?: string;
    
    /** Execution duration in ms */
    durationMs: number;
    
    /** Timestamp when execution started */
    startedAt: string;
    
    /** Timestamp when execution ended */
    endedAt: string;
}

/**
 * Checkpoint data for crash recovery
 */
export interface IExecutionCheckpoint {
    /** Workflow instance ID */
    workflowId: string;
    
    /** Session ID */
    sessionId: string;
    
    /** Graph name */
    graphName: string;
    
    /** Timestamp */
    timestamp: string;
    
    /** Completed node IDs */
    completedNodes: string[];
    
    /** Current execution context snapshot */
    contextSnapshot: Record<string, any>;
    
    /** Node execution results */
    nodeResults: Record<string, INodeExecutionResult>;
    
    /** Currently running node IDs (for parallel execution) */
    runningNodes: string[];
}

/**
 * Debug mode options
 */
export interface IDebugOptions {
    /** Enable step-through mode */
    stepThrough: boolean;
    
    /** Log all port values */
    logPortValues: boolean;
    
    /** Use mock agent responses */
    mockAgents: boolean;
    
    /** Mock responses by node ID */
    mockResponses?: Record<string, any>;
    
    /** Breakpoint node IDs */
    breakpoints?: string[];
}

/**
 * Node executor function signature
 * Each node type implements this to define its behavior
 */
export type NodeExecutor = (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
) => Promise<Record<string, any>>;

/**
 * Execution context API available to node executors
 */
export interface IExecutionContextAPI {
    /** Get a variable value */
    getVariable(id: string): any;
    
    /** Set a variable value */
    setVariable(id: string, value: any): void;
    
    /** Get a parameter value */
    getParameter(name: string): any;
    
    /** Evaluate an expression */
    evaluate(expression: string): any;
    
    /** Render a template string */
    renderTemplate(template: string): string;
    
    /** Log a message */
    log(message: string, level?: 'info' | 'warn' | 'error' | 'debug'): void;
    
    /** Request an agent from the pool */
    requestAgent(roleId: string, options?: { timeoutMs?: number }): Promise<string>;
    
    /** Release an agent back to the pool */
    releaseAgent(agentName: string): void;
    
    /** Run an agent task with CLI callback requirement */
    runAgentTask(agentName: string, prompt: string, options?: {
        model?: string;
        timeoutMs?: number;
        /** Stage for CLI callback (required) */
        stage?: 'implementation' | 'review' | 'analysis' | 'context' | 'planning' | 'finalization';
    }): Promise<{ success: boolean; output: string; fromCallback?: boolean }>;
    
    /** Emit an event */
    emitEvent(eventType: string, payload?: any): void;
    
    /** Wait for an external event */
    waitForEvent(eventType: string, timeoutMs?: number): Promise<any>;
    
    /** Execute a CLI command */
    executeCommand(command: string, options?: {
        cwd?: string;
        timeoutMs?: number;
    }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    
    /** Read a file */
    readFile(path: string): Promise<string>;
    
    /** Get the workflow services */
    getWorkflowServices(): any;
    
    /** Check if workflow is paused/cancelled */
    shouldStop(): boolean;
    
    /** Sleep for specified milliseconds */
    sleep(ms: number): Promise<void>;
}

