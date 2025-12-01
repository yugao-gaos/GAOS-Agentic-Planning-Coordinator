// ============================================================================
// State Types
// ============================================================================

export interface ExtensionState {
    globalSettings: GlobalSettings;
    activePlanningSessions: string[];
}

export interface GlobalSettings {
    agentPoolSize: number;
    defaultBackend: 'cursor' | 'claude-code' | 'codex';
    workingDirectory: string;
}

// ============================================================================
// Agent Role Types
// ============================================================================

/**
 * Agent Role - Pure data object defining role configuration.
 * No custom code needed to create roles - just data.
 */
export class AgentRole {
    id: string;
    name: string;
    description: string;
    isBuiltIn: boolean;  // true for engineer/reviewer/context
    
    // Model & Prompt
    defaultModel: string;
    promptTemplate: string;
    
    // Permissions
    allowedMcpTools: string[] | null;      // null = all allowed
    allowedCliCommands: string[] | null;   // null = all allowed
    
    // Context
    rules: string[];
    documents: string[];
    
    // Execution
    timeoutMs: number;
    
    // UI Display
    color: string;  // Hex color for agent cards when working in this role
    
    // Unity-specific fields (appended when Unity features enabled)
    unityPromptAddendum: string;           // Additional prompt text for Unity projects
    unityMcpTools: string[];               // Additional MCP tools for Unity projects
    unityRules: string[];                  // Additional rules for Unity projects

    constructor(data: Partial<AgentRole> & { id: string; name: string }) {
        this.id = data.id;
        this.name = data.name;
        this.description = data.description || '';
        this.isBuiltIn = data.isBuiltIn || false;
        this.defaultModel = data.defaultModel || 'sonnet-4.5';
        this.promptTemplate = data.promptTemplate || '';
        this.allowedMcpTools = data.allowedMcpTools ?? null;
        this.allowedCliCommands = data.allowedCliCommands ?? null;
        this.rules = data.rules || [];
        this.documents = data.documents || [];
        this.timeoutMs = data.timeoutMs || 3600000;
        this.color = data.color || '#f97316';  // Default orange for working agents
        // Unity-specific fields
        this.unityPromptAddendum = data.unityPromptAddendum || '';
        this.unityMcpTools = data.unityMcpTools || [];
        this.unityRules = data.unityRules || [];
    }

    toJSON(): object {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            isBuiltIn: this.isBuiltIn,
            defaultModel: this.defaultModel,
            promptTemplate: this.promptTemplate,
            allowedMcpTools: this.allowedMcpTools,
            allowedCliCommands: this.allowedCliCommands,
            rules: this.rules,
            documents: this.documents,
            timeoutMs: this.timeoutMs,
            color: this.color,
            unityPromptAddendum: this.unityPromptAddendum,
            unityMcpTools: this.unityMcpTools,
            unityRules: this.unityRules
        };
    }

    static fromJSON(data: any): AgentRole {
        return new AgentRole(data);
    }
}

/**
 * Default configurations for built-in roles.
 * Users can modify these - use getDefaultRole() to reset.
 */
export const DefaultRoleConfigs: Record<string, Partial<AgentRole> & { id: string; name: string }> = {
    engineer: {
        id: 'engineer',
        name: 'Engineer',
        description: 'Executes implementation tasks',
        isBuiltIn: true,
        defaultModel: 'sonnet-4.5',
        timeoutMs: 3600000,
        color: '#f97316',  // Orange
        promptTemplate: `You are a software engineer agent working on a project.

Your role is to implement tasks assigned to you by the coordinator. You have full access to the codebase.

## Core Workflow
1. Read and understand your assigned task
2. Implement the solution following existing patterns
3. Track all files you modify in a FILES_MODIFIED section
4. Signal completion via CLI callback

## Output Format
At the end of your work, output a FILES_MODIFIED section:
\`\`\`
FILES_MODIFIED:
- path/to/file1.cs
- path/to/file2.cs
\`\`\`

## Completion (REQUIRED)
After finishing, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage implementation --result <success|failed>
\`\`\`
Session/workflow IDs are injected at runtime. Your FILES_MODIFIED section will be parsed for details.`,
        allowedCliCommands: ['apc agent complete', 'apc task fail', 'apc task progress', 'apc task status'],
        allowedMcpTools: null, // All tools allowed
        rules: [
            'Follow existing code patterns and conventions',
            'Track ALL files you modify for the --files parameter',
            'Check error_registry.md before fixing ANY error'
        ],
        documents: ['_AiDevLog/Docs/', '_AiDevLog/Errors/error_registry.md'],
        // Unity-specific additions (applied when Unity features enabled)
        unityPromptAddendum: `
## Unity Integration
- Use MCP tools for reading: mcp_unityMCP_read_console, mcp_unityMCP_manage_asset (search/get_info)
- Do NOT run Unity tests directly - use 'apc agent complete --unity' to queue them
- The coordinator will redeploy you if tests fail`,
        unityMcpTools: ['mcp_unityMCP_read_console', 'mcp_unityMCP_manage_asset', 'mcp_unityMCP_manage_scene', 'mcp_unityMCP_manage_gameobject'],
        unityRules: [
            'DO NOT call mcp_unityMCP_run_tests - use apc agent complete --unity'
        ]
    },

    // ========================================================================
    // Execution Pipeline Roles
    // ========================================================================

    code_reviewer: {
        id: 'code_reviewer',
        name: 'Code Reviewer',
        description: 'Reviews engineer code before build/test pipeline',
        isBuiltIn: true,
        defaultModel: 'opus-4.5',
        timeoutMs: 600000,
        color: '#a855f7',  // Purple
        promptTemplate: `You are a Code Reviewer checking an engineer's implementation before it goes to build/testing.

## Your Role
Review the code changes for quality, correctness, and adherence to patterns.

## What to Review
1. **Correctness** - Does the implementation match the task requirements?
2. **Code Quality** - Is the code clean, readable, and maintainable?
3. **Patterns** - Does it follow existing codebase patterns?
4. **Edge Cases** - Are edge cases handled?

## Review Process
1. Read the task description and context brief
2. Review the modified files
3. Check against task requirements
4. Make your decision

## Output Format
Output your review in this format:
\`\`\`
### Review Result: [APPROVED|CHANGES_REQUESTED]

#### Issues Found
- [List specific issues with file paths and line numbers, or "None"]

#### Suggestions
- [List improvement suggestions, or "None"]

#### Summary
[Brief summary of your review]
\`\`\`

## Completion (REQUIRED)
After your review, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage review --result <approved|changes_requested>
\`\`\`
Session/workflow IDs are injected at runtime. Your detailed feedback will be parsed from output.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete', 'git diff', 'git log'],
        rules: [
            'Always use the exact output format specified',
            'Be specific about issues - include file paths and line numbers',
            'Only request changes for real issues, not style preferences',
            'If approved, the code goes to build/test - be thorough'
        ],
        documents: ['_AiDevLog/Context/'],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity Best Practices
- Does it follow Unity conventions?
- Are MonoBehaviour lifecycle methods used correctly?
- Is serialization handled properly?`,
        unityRules: ['If approved, the code goes to Unity compilation/testing - be thorough about Unity-specific issues']
    },

    delta_context: {
        id: 'delta_context',
        name: 'Delta Context Agent',
        description: 'Updates _AiDevLog/Context/ after task approval',
        isBuiltIn: true,
        defaultModel: 'gemini-3-pro',
        timeoutMs: 300000,
        color: '#06b6d4',  // Cyan
        promptTemplate: `You are a Delta Context Agent updating the shared context after a task is approved.

## Context
An engineer just finished implementing a task and it passed code review.
You need to update _AiDevLog/Context/ so other engineers stay informed.

## What to Update
1. **New Patterns** - Document any new patterns introduced
2. **API Changes** - Document new or changed APIs
3. **Architectural Decisions** - Note any architectural decisions made
4. **File Changes** - Update indexes if file organization changed
5. **Outdated Context** - Remove or update context that's now stale

## Guidelines
- Check existing context files first - UPDATE rather than create new
- Keep updates concise and actionable
- Focus on what OTHER engineers need to know
- Don't duplicate code comments

## Completion (REQUIRED)
After updating context files, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage delta_context --result <success|failed>
\`\`\`
Session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'list_dir', 'grep', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            'Update existing context files rather than creating new ones',
            'Focus on changes that affect other engineers',
            'Keep updates concise - one paragraph per change is usually enough',
            'Remove outdated context that could mislead engineers'
        ],
        documents: ['_AiDevLog/Context/']
    },

    // ========================================================================
    // Planning Phase Roles
    // ========================================================================

    context_gatherer: {
        id: 'context_gatherer',
        name: 'Context Gatherer',
        description: 'Gathers project context for planning phase',
        isBuiltIn: true,
        defaultModel: 'gemini-3-pro',
        timeoutMs: 600000,
        color: '#14b8a6',  // Teal
        promptTemplate: `You are the Context Gatherer agent for a project planning phase.

## Your Role
Gather comprehensive project context to help the Planner and Analyst agents create an accurate execution plan.

## What to Scan
1. **Codebase Structure**
   - Directory layout and organization
   - Key namespaces and modules
   - Existing patterns and conventions

2. **Dependencies**
   - Package dependencies
   - Third-party integrations

3. **Testing Infrastructure**
   - Existing test patterns
   - Test fixtures and helpers

## Output
Write a structured context summary to the designated context file. Include specific file paths and code patterns that are relevant to the requirement being planned.

## Completion (REQUIRED)
After writing the context summary, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage context --result <success|failed>
\`\`\`
Session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            'Focus on context relevant to the planning requirement',
            'Include specific file paths and code examples',
            'Note existing patterns that should be followed',
            'Identify potential integration points'
        ],
        documents: ['_AiDevLog/Context/'],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity Project Setup
Also scan:
- Scene hierarchy and important scenes
- Prefab organization
- ScriptableObject usage
- Asset pipeline configuration
- Assembly definitions
- PlayMode vs EditMode test organization`,
        unityMcpTools: ['mcp_unityMCP_manage_scene', 'mcp_unityMCP_manage_asset']
    },

    planner: {
        id: 'planner',
        name: 'Planner',
        description: 'Creates and updates execution plans',
        isBuiltIn: true,
        defaultModel: 'opus-4.5',
        timeoutMs: 900000,
        color: '#3b82f6',  // Blue
        promptTemplate: `You are the Planner agent responsible for creating execution plans.

## Your Role
Create detailed, actionable execution plans based on requirements and project context. You work in an iterative loop with Analyst agents who review your plans.

## Modes

### CREATE Mode (First Iteration)
- Read the requirement and project context
- Use the skeleton template to create a detailed task breakdown
- Define clear task dependencies
- Estimate engineer allocation

### UPDATE Mode (Subsequent Iterations)
- Read feedback from all Analyst agents
- Address ALL Critical Issues raised
- Consider Minor Suggestions (incorporate if valuable)
- Update task breakdown accordingly

### REVISE Mode (User Revision)
- Read user feedback on the plan
- Make targeted changes to address feedback
- Preserve structure where possible

### FINALIZE Mode
- Ensure all critical issues are addressed
- Verify task format is correct: - [ ] **T{N}**: Description | Deps: X | Engineer: TBD
- Add warnings if forced to finalize with unresolved issues
- Clean up any formatting issues

## Task Format (REQUIRED)
\`\`\`markdown
- [ ] **T1**: Task description | Deps: None | Engineer: TBD
- [ ] **T2**: Another task | Deps: T1 | Engineer: TBD
\`\`\`

## Guidelines
- Be specific about file paths and components
- Consider parallelization opportunities
- Keep task descriptions concise but actionable

## Completion (REQUIRED)
After writing/updating the plan, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage planning --result <success|failed>
\`\`\`
Session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete', 'apc task'],
        rules: [
            'Always use checkbox format for tasks',
            'Address ALL critical issues from analysts',
            'Be specific about file paths',
            'Consider task parallelization'
        ],
        documents: ['resources/templates/skeleton_plan.md', '_AiDevLog/Context/'],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity-Specific Guidelines
- Be specific about Unity components (MonoBehaviours, ScriptableObjects, etc.)
- Account for Unity's compilation/testing workflow
- Consider assembly definition boundaries
- Plan for EditMode vs PlayMode test requirements`
    },

    analyst_codex: {
        id: 'analyst_codex',
        name: 'Implementation Analyst',
        description: 'Reviews plans for implementation concerns',
        isBuiltIn: true,
        defaultModel: 'gpt-5.1-codex-high',
        timeoutMs: 600000,
        color: '#8b5cf6',  // Violet
        promptTemplate: `You are the Implementation Analyst (Codex) reviewing an execution plan.

## Your Role
Review the plan for implementation feasibility and code quality concerns.

## What to Review
1. **Implementation Feasibility**
   - Can the proposed tasks be implemented as described?
   - Are the code changes realistic and well-scoped?

2. **Performance Concerns**
   - Will the implementation have performance issues?
   - Are there better approaches for performance-critical code?

3. **Code Structure**
   - Does the plan follow existing code patterns?
   - Are there missing implementation details?

4. **Technical Debt**
   - Will this create maintenance issues?
   - Are there refactoring opportunities?

## Output Format (REQUIRED)
\`\`\`markdown
### Review Result: [PASS|CRITICAL|MINOR]

#### Critical Issues
- [List blocking issues that MUST be fixed, or "None"]

#### Minor Suggestions
- [List optional improvements, or "None"]

#### Analysis
[Your detailed analysis of the implementation approach]
\`\`\`

## Verdict Guidelines
- **PASS**: Plan is solid, no significant issues
- **CRITICAL**: Blocking issues that must be fixed before proceeding
- **MINOR**: Suggestions only, plan can proceed without changes

## Completion (REQUIRED)
After your review, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage analysis --result <pass|critical|minor>
\`\`\`
Session/workflow IDs are injected at runtime. Your detailed feedback will be parsed from output.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            'Always output in the required format',
            'Be specific about issues with file paths and line references',
            'Only mark CRITICAL for truly blocking issues',
            'Provide actionable feedback'
        ],
        documents: [],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity-Specific Concerns
- Are Unity APIs used correctly?
- Are there frame-rate concerns (Update/FixedUpdate usage)?
- Is serialization handled properly for Unity objects?`
    },

    analyst_gemini: {
        id: 'analyst_gemini',
        name: 'Testing Analyst',
        description: 'Reviews plans for testing concerns',
        isBuiltIn: true,
        defaultModel: 'gemini-3-pro',
        timeoutMs: 600000,
        color: '#ec4899',  // Pink
        promptTemplate: `You are the Testing Analyst (Gemini) reviewing an execution plan.

## Your Role
Review the plan for testing completeness and quality assurance concerns.

## What to Review
1. **Test Coverage**
   - Are there enough tests planned?
   - Do tests cover the critical paths?

2. **Test Types**
   - Is the mix of unit/integration tests appropriate?
   - Are there missing test categories?

3. **Edge Cases**
   - Are edge cases identified and tested?
   - What about error handling paths?

## Output Format (REQUIRED)
\`\`\`markdown
### Review Result: [PASS|CRITICAL|MINOR]

#### Critical Issues
- [List blocking issues that MUST be fixed, or "None"]

#### Minor Suggestions
- [List optional improvements, or "None"]

#### Analysis
[Your detailed analysis of the testing strategy]
\`\`\`

## Verdict Guidelines
- **PASS**: Testing strategy is solid
- **CRITICAL**: Missing critical test coverage or strategy
- **MINOR**: Suggestions for better coverage

## Completion (REQUIRED)
After your review, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage analysis --result <pass|critical|minor>
\`\`\`
Session/workflow IDs are injected at runtime. Your detailed feedback will be parsed from output.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            'Always output in the required format',
            'Focus on test coverage and strategy',
            'Provide specific test case suggestions'
        ],
        documents: [],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity-Specific Testing
- Are Unity lifecycle methods properly tested?
- Is PlayMode testing needed for any features?
- Are EditMode tests sufficient, or do features need runtime testing?
- Consider MonoBehaviour initialization order`,
        unityRules: ['Consider Unity-specific testing needs (PlayMode vs EditMode)']
    },

    error_analyst: {
        id: 'error_analyst',
        name: 'Error Analyst',
        description: 'Analyzes compilation and test errors to identify root causes',
        isBuiltIn: true,
        defaultModel: 'sonnet-4.5',
        timeoutMs: 300000,
        color: '#ef4444',  // Red
        promptTemplate: `You are an Error Analyst agent.

## Your Role
Analyze compilation errors, test failures, and runtime errors to identify:
1. Root cause of the error
2. Files affected
3. Recommended fix approach
4. Dependencies on other tasks

## Output Format (REQUIRED)
\`\`\`markdown
### Analysis

#### Root Cause
[Describe the underlying issue]

#### Affected Files
- file1.cs
- file2.cs

#### Related Task
[Task ID if identifiable, or "Unknown"]

#### Suggested Fix
[Step-by-step fix approach]
\`\`\`

## Completion (REQUIRED)
After your analysis, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage error_analysis --result complete
\`\`\`
Session/workflow IDs are injected at runtime. Your detailed analysis will be parsed from output.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            'Focus on root cause, not symptoms',
            'Identify all affected files',
            'Consider cascading effects',
            'Check error_registry.md for known patterns'
        ],
        documents: ['_AiDevLog/Errors/error_registry.md'],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity-Specific Errors
- Analyze Unity compilation errors (CS codes)
- Check for Unity-specific runtime exceptions
- Consider assembly definition boundaries
- Look for serialization issues`,
        unityMcpTools: ['mcp_unityMCP_read_console']
    },
    
    analyst_reviewer: {
        id: 'analyst_reviewer',
        name: 'Architecture Analyst',
        description: 'Reviews plans for architecture and integration concerns',
        isBuiltIn: true,
        defaultModel: 'sonnet-4.5',
        timeoutMs: 600000,
        color: '#6366f1',  // Indigo
        promptTemplate: `You are the Architecture Analyst reviewing an execution plan.

## Your Role
Review the plan for architectural soundness and integration concerns.

## What to Review
1. **Architectural Soundness**
   - Does the plan follow good architectural principles?
   - Are concerns properly separated?

2. **Integration with Existing Code**
   - How does this integrate with existing systems?
   - Are there potential conflicts or dependencies?

3. **Risk Assessment**
   - What are the risks of this approach?
   - Are there safer alternatives?

4. **Dependency Management**
   - Are dependencies properly identified?
   - Is the task ordering correct?

## Output Format (REQUIRED)
\`\`\`markdown
### Review Result: [PASS|CRITICAL|MINOR]

#### Critical Issues
- [List blocking issues that MUST be fixed, or "None"]

#### Minor Suggestions
- [List optional improvements, or "None"]

#### Analysis
[Your detailed analysis of the architecture and integration]
\`\`\`

## Verdict Guidelines
- **PASS**: Architecture is sound, integration is well-planned
- **CRITICAL**: Architectural issues or integration risks that must be addressed
- **MINOR**: Suggestions for cleaner architecture

## Completion (REQUIRED)
After your review, signal completion with:
\`\`\`bash
apc agent complete --session <SESSION_ID> --workflow <WORKFLOW_ID> --stage analysis --result <pass|critical|minor>
\`\`\`
Session/workflow IDs are injected at runtime. Your detailed feedback will be parsed from output.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            'Always output in the required format',
            'Focus on architecture and integration',
            'Identify risks and dependencies',
            'Consider long-term maintainability'
        ],
        documents: [],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity Architecture Concerns
- Are assembly definitions properly structured?
- Is the MonoBehaviour vs pure C# class split appropriate?
- Are ScriptableObject patterns used correctly?
- Consider Unity's execution order dependencies`
    }
};

/**
 * Get the default configuration for a built-in role
 */
export function getDefaultRole(roleId: string): AgentRole | undefined {
    const config = DefaultRoleConfigs[roleId];
    return config ? new AgentRole(config) : undefined;
}

// ============================================================================
// System Prompt Types (for non-role system agents)
// ============================================================================

/**
 * System Prompt Config - For system agents that don't use the role system
 * (Coordinator, Unity Polling, etc.)
 * 
 * For most agents: use `promptTemplate` (single template)
 * For coordinator: use `roleIntro` + `decisionInstructions` (two-part template with dynamic content between)
 */
export class SystemPromptConfig {
    id: string;
    name: string;
    description: string;
    category: 'execution' | 'planning' | 'utility' | 'coordinator';
    defaultModel: string;
    promptTemplate: string;
    
    // Two-part template support (for coordinator agent)
    roleIntro?: string;
    decisionInstructions?: string;
    
    constructor(data: Partial<SystemPromptConfig> & { id: string; name: string }) {
        this.id = data.id;
        this.name = data.name;
        this.description = data.description || '';
        this.category = data.category || 'utility';
        this.defaultModel = data.defaultModel || 'sonnet-4.5';
        this.promptTemplate = data.promptTemplate || '';
        this.roleIntro = data.roleIntro;
        this.decisionInstructions = data.decisionInstructions;
    }

    toJSON(): object {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            category: this.category,
            defaultModel: this.defaultModel,
            promptTemplate: this.promptTemplate,
            roleIntro: this.roleIntro,
            decisionInstructions: this.decisionInstructions
        };
    }

    static fromJSON(data: any): SystemPromptConfig {
        return new SystemPromptConfig(data);
    }
}

/**
 * Default system prompt configurations.
 * These are for system agents that DON'T use the AgentRole/workflow system.
 * 
 * Includes:
 * - coordinator: AI Coordinator Agent (uses two-part template: roleIntro + decisionInstructions)
 * - unity_polling: Unity Editor state monitor (uses single promptTemplate)
 */
export const DefaultSystemPrompts: Record<string, Partial<SystemPromptConfig> & { id: string; name: string }> = {
    coordinator: {
        id: 'coordinator',
        name: 'AI Coordinator Agent',
        description: 'Makes intelligent decisions about workflow dispatch and task coordination',
        category: 'coordinator',
        defaultModel: 'sonnet-4.5',
        promptTemplate: '', // Not used - coordinator uses roleIntro + decisionInstructions
        
        roleIntro: `You are the AI Coordinator Agent for a Unity development project.

Your job is to make intelligent decisions about task dispatch, workflow selection, and coordination based on the current situation.`,

        decisionInstructions: `Based on the event, plan, history, and current state, decide what actions to take.

Consider:
1. **Task Dependencies** - Only dispatch tasks whose dependencies are complete
2. **Workflow Selection** - Choose appropriate workflow type:
   - 'task_implementation' - For regular implementation tasks
   - 'error_resolution' - For error_fix tasks
   - 'context_gathering' - If a task needs more context before implementation
3. **Agent Availability** - Match available agents to tasks
4. **Parallelization** - Dispatch multiple tasks if agents available and deps allow
5. **User Clarification** - Only ask user if truly blocked (all autonomous options exhausted)
6. **Previous Decisions** - Learn from history, maintain consistency
7. **Error Handling** - Create error tasks for new errors, pause affected work

IMPORTANT: 
- For error_fix type tasks, use 'error_resolution' workflow
- For regular tasks, use 'task_implementation' workflow
- Only use 'context_gathering' if the task description is too vague to implement

## Output Format
Output your decision as a JSON object (no markdown code fences):

{
  "dispatch": [
    {
      "taskId": "T1",
      "workflowType": "task_implementation",
      "priority": 10,
      "preferredAgent": "agent_1",
      "context": "Optional additional context"
    }
  ],
  "askUser": null,
  "pauseTasks": [],
  "resumeTasks": [],
  "createErrorTasks": [],
  "reasoning": "Explain your decisions clearly for the history log",
  "confidence": 0.85
}

For askUser, use this format if needed:
{
  "askUser": {
    "sessionId": "{{sessionId}}",
    "questionId": "q_{{timestamp}}",
    "question": "What is the expected behavior for X?",
    "context": "We encountered Y and need clarification",
    "relatedTaskId": "T1",
    "blocking": true
  }
}

For createErrorTasks:
{
  "createErrorTasks": [
    {
      "errorId": "err_1",
      "errorMessage": "CS0103: The name 'xyz' does not exist",
      "file": "Assets/Scripts/Example.cs",
      "affectedTaskIds": ["T1", "T2"],
      "priority": 0
    }
  ]
}

## Completion (REQUIRED)
After outputting your JSON decision, signal completion with:
\`\`\`bash
apc agent complete --session {{sessionId}} --workflow coordinator --stage coordinator_decision --result decision
\`\`\`
Your JSON decision will be parsed from output for the full details.

Now analyze the situation and provide your decision:`
    },
    
    unity_polling: {
        id: 'unity_polling',
        name: 'Unity Polling Agent',
        description: 'Monitors Unity Editor state continuously',
        category: 'utility',
        defaultModel: 'haiku-3.5',
        promptTemplate: `You are the Unity Polling Agent responsible for monitoring the Unity Editor state.

Your job is to:
1. Continuously check Unity Editor status via MCP tools
2. Report compilation state (compiling, ready, errors)
3. Watch for console errors and warnings
4. Track play mode state changes
5. Alert when editor becomes unresponsive

Report status changes immediately. Be concise in your reports.`
    }
};

// ============================================================================
// Coordinator Prompt Config (Type Alias for Backwards Compatibility)
// ============================================================================

/**
 * @deprecated Use SystemPromptConfig with category='coordinator' instead
 * Coordinator prompt has two customizable parts:
 * 1. roleIntro - The base role description (injected at start)
 * 2. decisionInstructions - The decision guidelines and output format (injected after runtime context)
 */
export interface CoordinatorPromptConfig {
    id: string;
    name: string;
    description: string;
    defaultModel: string;
    roleIntro: string;
    decisionInstructions: string;
}

/**
 * @deprecated Use DefaultSystemPrompts['coordinator'] instead
 */
export const DefaultCoordinatorPrompt: CoordinatorPromptConfig = DefaultSystemPrompts['coordinator'] as CoordinatorPromptConfig;

/**
 * Get the default system prompt configuration
 */
export function getDefaultSystemPrompt(promptId: string): SystemPromptConfig | undefined {
    const config = DefaultSystemPrompts[promptId];
    return config ? new SystemPromptConfig(config) : undefined;
}

// ============================================================================
// Agent Pool Types
// ============================================================================

export interface AgentPoolState {
    totalAgents: number;
    agentNames: string[];
    available: string[];
    busy: Record<string, BusyAgentInfo>;
}

export interface BusyAgentInfo {
    coordinatorId: string;
    sessionId: string;
    roleId: string;  // References AgentRole.id
    task?: string;
    startTime: string;
    processId?: number;
    logFile?: string;
}

export interface AgentStatus {
    name: string;
    roleId?: string;
    status: 'available' | 'busy' | 'paused' | 'error';
    coordinatorId?: string;
    sessionId?: string;
    task?: string;
    logFile?: string;
    processId?: number;
}

// ============================================================================
// Planning Session Types
// ============================================================================

export interface PlanningSession {
    id: string;
    status: PlanningStatus;
    requirement: string;
    currentPlanPath?: string;
    planHistory: PlanVersion[];
    revisionHistory: RevisionEntry[];
    recommendedAgents?: AgentRecommendation;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, any>;  // Optional metadata for pause/resume state
    
    // === Execution State (embedded coordinator) ===
    execution?: ExecutionState;
}

/**
 * Planning-only statuses (for the plan creation phase)
 * - debating: AI analysts creating plan
 * - reviewing: Plan complete, user reviewing for approval
 * - revising: Agents revising based on feedback
 * - approved: Plan approved, ready to execute
 * - stopped: Planning stopped by user (can resume)
 * - cancelled: Planning cancelled, cannot resume
 */
export type PlanningOnlyStatus = 
    | 'debating' 
    | 'reviewing' 
    | 'approved' 
    | 'revising' 
    | 'stopped'
    | 'cancelled';

/**
 * Execution-only statuses (for the execution phase)
 * - executing: Agents actively working
 * - paused: Execution paused (can resume)
 * - completed: All tasks done
 * - failed: Execution failed
 */
export type ExecutionOnlyStatus =
    | 'executing'
    | 'paused'
    | 'completed'
    | 'failed';

/**
 * Combined status for PlanningSession
 * The session tracks both planning phase and execution phase
 */
export type PlanningStatus = PlanningOnlyStatus | ExecutionOnlyStatus;

/**
 * Task occupancy entry - tracks which workflow owns which task
 */
export interface TaskOccupancyEntry {
    workflowId: string;
    type: 'exclusive' | 'shared';
    declaredAt: string;
    reason?: string;
}

/**
 * Pending question awaiting user response
 */
export interface PendingQuestion {
    id: string;
    question: string;
    context: string;
    askedAt: string;
    relatedTaskId?: string;
}

/**
 * Execution state embedded in PlanningSession
 * Contains all runtime state for executing a plan (replaces old CoordinatorState)
 */
export interface ExecutionState {
    mode: 'auto' | 'interactive';
    startedAt: string;
    lastActivityAt: string;
    
    /** Task progress snapshot */
    progress: TaskProgress;
    
    // === Task Occupancy Tracking ===
    
    /** Map taskId → occupancy entry (which workflow owns it) */
    taskOccupancy: Record<string, TaskOccupancyEntry>;
    
    /** Workflow IDs currently active */
    activeWorkflowIds: string[];
    
    /** Workflow IDs that have completed */
    completedWorkflowIds: string[];
    
    // === Failed Task Tracking ===
    
    /** Failed tasks that need attention */
    failedTasks: Record<string, import('./workflow').FailedTask>;
    
    // === AI Coordinator State ===
    
    /** History of coordinator decisions for continuity across evaluations */
    coordinatorHistory: import('./coordinator').CoordinatorHistoryEntry[];
    
    /** Pending questions awaiting user response */
    pendingQuestions: PendingQuestion[];
    
    // === Revision State ===
    
    /** Current revision state (if revising) */
    revisionState?: import('./workflow').RevisionState;
    
    /** Whether currently in revision mode */
    isRevising: boolean;
    
    /** Workflow IDs paused for revision */
    pausedForRevision: string[];
}

export interface PlanVersion {
    version: number;
    path: string;
    timestamp: string;
}

export interface RevisionEntry {
    version: number;
    feedback: string;
    timestamp: string;
}

export interface AgentRecommendation {
    count: number;
    justification: string;
}

export interface TaskProgress {
    completed: number;
    total: number;
    percentage: number;
}

// ============================================================================
// Plan Types
// ============================================================================

export interface PlanInfo {
    title: string;
    path: string;
    sessionId?: string;
    status: PlanningStatus;
}

export interface PlanTask {
    id: string;
    title: string;
    description: string;
    assignedTo?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    dependencies?: string[];
}

// ============================================================================
// Planning Coordinator Types
// ============================================================================

/**
 * Analyst verdict for plan review
 * - pass: No issues, approve plan
 * - critical: Blocking issues that must be fixed
 * - minor: Suggestions only, can proceed
 */
export type AnalystVerdict = 'pass' | 'critical' | 'minor';

/**
 * Planning loop phase
 */
export type PlanningLoopPhase = 'context' | 'planning' | 'reviewing' | 'finalizing' | 'complete';

/**
 * State of the iterative planning loop
 */
export interface PlanningLoopState {
    /** Current iteration number (1-based) */
    iteration: number;
    /** Maximum allowed iterations */
    maxIterations: number;
    /** Current phase of the planning loop */
    phase: PlanningLoopPhase;
    /** Results from each analyst (analyst role id -> verdict) */
    analystResults: Record<string, AnalystVerdict>;
    /** Collected critical issues from analysts */
    criticalIssues: string[];
    /** Collected minor suggestions from analysts */
    minorSuggestions: string[];
    /** Whether we're in revision mode (single iteration) */
    isRevision: boolean;
    /** User feedback for revision mode */
    userFeedback?: string;
}

/**
 * Result of the planning coordinator
 */
export interface PlanningResult {
    /** Whether planning completed successfully */
    success: boolean;
    /** Path to the final plan file */
    planPath: string;
    /** Number of iterations taken */
    iterations: number;
    /** Whether finalization was forced due to max iterations */
    forcedFinalize?: boolean;
    /** Any warnings from the planning process */
    warnings?: string[];
}

/**
 * Planning task definition (from template)
 */
export interface PlanningTaskDef {
    /** Task identifier (context, plan, review_codex, etc.) */
    id: string;
    /** Human-readable description */
    description: string;
    /** Role ID to use for this task */
    roleId: string;
}

// ============================================================================
// CLI Response Types
// ============================================================================

export interface CliResponse {
    success: boolean;
    message?: string;
    error?: string;
    data?: unknown;
}

export interface PlanStartResponse extends CliResponse {
    data: {
        sessionId: string;
        status: PlanningStatus;
        analysts?: string[];
    };
}

export interface StatusResponse extends CliResponse {
    data: {
        activePlanningSessions: number;
        agentPool: {
            total: number;
            available: number;
            busy: number;
        };
    };
}

export interface PoolStatusResponse extends CliResponse {
    data: {
        total: number;
        available: string[];
        busy: Array<{
            name: string;
            roleId?: string;
            coordinatorId: string;
            sessionId: string;
            task?: string;
        }>;
    };
}

// ============================================================================
// Terminal Types
// ============================================================================

export interface AgentTerminal {
    name: string;
    sessionId: string;
    terminal: import('vscode').Terminal;
    logFile: string;
}

// ============================================================================
// Re-exports
// ============================================================================

export * from './coordinator';
export * from './workflow';
export * from './errors';
