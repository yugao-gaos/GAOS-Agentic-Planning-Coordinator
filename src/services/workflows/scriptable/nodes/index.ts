// ============================================================================
// Node Implementations Index
// ============================================================================

// Flow nodes
export { 
    StartNodeDefinition, 
    StartNodeExecutor,
    EndNodeDefinition, 
    EndNodeExecutor,
    registerFlowNodes 
} from './FlowNodes';

// Agent nodes
export { 
    AgentRequestNodeDefinition, 
    AgentRequestNodeExecutor,
    AgenticWorkNodeDefinition, 
    AgenticWorkNodeExecutor,
    AgentReleaseNodeDefinition,
    AgentReleaseNodeExecutor,
    AgentBenchNodeDefinition,
    AgentBenchNodeExecutor,
    registerAgentNodes 
} from './AgentNodes';

// Action nodes
export { 
    EventNodeDefinition, 
    EventNodeExecutor,
    CommandNodeDefinition, 
    CommandNodeExecutor,
    DelayNodeDefinition, 
    DelayNodeExecutor,
    LogNodeDefinition, 
    LogNodeExecutor,
    WaitEventNodeDefinition,
    WaitEventNodeExecutor,
    registerActionNodes 
} from './ActionNodes';

// Data nodes
export { 
    KnowledgeNodeDefinition, 
    KnowledgeNodeExecutor,
    ContextNodeDefinition, 
    ContextNodeExecutor,
    FormatterNodeDefinition, 
    FormatterNodeExecutor,
    VariableNodeDefinition, 
    VariableNodeExecutor,
    SubgraphNodeDefinition, 
    SubgraphNodeExecutor,
    registerDataNodes 
} from './DataNodes';

// Control flow nodes
export { 
    IfConditionNodeDefinition, 
    IfConditionNodeExecutor,
    SwitchCaseNodeDefinition, 
    SwitchCaseNodeExecutor,
    ForLoopNodeDefinition, 
    ForLoopNodeExecutor,
    WhileLoopNodeDefinition, 
    WhileLoopNodeExecutor,
    registerControlFlowNodes 
} from './ControlFlowNodes';

// Parallel nodes
export { 
    BranchNodeDefinition, 
    BranchNodeExecutor,
    SyncNodeDefinition, 
    SyncNodeExecutor,
    registerParallelNodes 
} from './ParallelNodes';

// Script node
export { 
    ScriptNodeDefinition, 
    ScriptNodeExecutor,
    registerScriptNode 
} from './ScriptNode';

// Annotation nodes (comment, group)
export { 
    CommentNodeDefinition, 
    CommentNodeExecutor,
    GroupNodeDefinition, 
    GroupNodeExecutor,
    registerAnnotationNodes 
} from './AnnotationNodes';

// ============================================================================
// Register all built-in nodes
// ============================================================================

import { registerFlowNodes } from './FlowNodes';
import { registerAgentNodes } from './AgentNodes';
import { registerActionNodes } from './ActionNodes';
import { registerDataNodes } from './DataNodes';
import { registerControlFlowNodes } from './ControlFlowNodes';
import { registerParallelNodes } from './ParallelNodes';
import { registerScriptNode } from './ScriptNode';
import { registerAnnotationNodes } from './AnnotationNodes';

let isRegistered = false;

/**
 * Register all built-in node types with the NodeRegistry
 * Safe to call multiple times - will only register once
 */
export function registerBuiltinNodes(): void {
    if (isRegistered) {
        return;
    }
    
    registerFlowNodes();
    registerAgentNodes();
    registerActionNodes();
    registerDataNodes();
    registerControlFlowNodes();
    registerParallelNodes();
    registerScriptNode();
    registerAnnotationNodes();
    
    isRegistered = true;
}

/**
 * Check if built-in nodes have been registered
 */
export function areBuiltinNodesRegistered(): boolean {
    return isRegistered;
}

