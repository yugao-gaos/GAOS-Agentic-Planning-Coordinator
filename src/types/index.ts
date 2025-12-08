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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        timeoutMs: 600000,  // 10 minutes
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

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedCliCommands: ['apc agent complete', 'apc task fail', 'apc task progress', 'apc task status'],
        allowedMcpTools: null, // All tools allowed
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
            'Follow existing code patterns and conventions',
            'Track ALL files you modify for the --files parameter',
            'Check error_registry.md before fixing ANY error'
        ],
        documents: ['_AiDevLog/Docs/', '_AiDevLog/Errors/error_registry.md'],
        // Unity-specific additions (applied when Unity features enabled)
        unityPromptAddendum: `
## Unity Integration
- Use MCP tools for asset info: mcp_unityMCP_manage_asset (search/get_info)
- Do NOT check compilation errors with read_console - the Unity pipeline handles that after your work
- Do NOT run Unity tests directly - use 'apc agent complete --unity' to queue them
- The coordinator will redeploy you if compilation or tests fail`,
        unityMcpTools: ['mcp_unityMCP_manage_asset', 'mcp_unityMCP_manage_scene', 'mcp_unityMCP_manage_gameobject'],
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
        defaultModel: 'gpt-5.1-codex-high',
        timeoutMs: 300000,  // 5 minutes
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

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete', 'git diff', 'git log'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
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

    // ========================================================================
    // Planning Phase Roles
    // ========================================================================

    context_gatherer: {
        id: 'context_gatherer',
        name: 'Context Gatherer',
        description: 'Gathers and updates project context in _AiDevLog/Context/',
        isBuiltIn: true,
        defaultModel: 'gemini-3-pro',
        timeoutMs: 300000,  // 5 minutes
        color: '#14b8a6',  // Teal
        promptTemplate: `You are the Context Gatherer agent for project context management.

## Your Role
You handle two modes of operation (specified at runtime):

### Mode 1: Context Gathering (before planning/implementation)
Gather comprehensive project context to help engineers understand the codebase:
- Scan codebase structure, patterns, and conventions
- Identify dependencies and integration points
- Document testing infrastructure
- Write structured context summaries to _AiDevLog/Context/

### Mode 2: Delta Context Update (after task completion)
Update _AiDevLog/Context/ to reflect changes from a completed task:
- Document new patterns introduced
- Update API/interface documentation
- Note architectural decisions made
- Remove or update stale context

## Guidelines
- UPDATE existing context files rather than creating duplicates
- Keep context concise and actionable
- Focus on what OTHER engineers need to know
- Include specific file paths and code examples

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
            'Update existing context files rather than creating new ones when possible',
            'Focus on context relevant to the task/requirement',
            'Include specific file paths and code examples',
            'Note existing patterns that should be followed',
            'Remove outdated context that could mislead engineers'
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
        timeoutMs: 600000,  // 10 minutes
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
- Verify task format is correct: - [ ] **{SESSION_ID}_T{N}**: Description | Deps: {SESSION_ID}_TX | Engineer: TBD
- Add warnings if forced to finalize with unresolved issues
- Clean up any formatting issues

## Task Format (REQUIRED)
Use GLOBAL task IDs with session prefix:
\`\`\`markdown
- [ ] **{SESSION_ID}_T1**: Task description | Deps: None | Engineer: TBD
- [ ] **{SESSION_ID}_T2**: Another task | Deps: {SESSION_ID}_T1 | Engineer: TBD
\`\`\`
Note: {SESSION_ID} is provided at runtime (e.g., ps_000001)

## Guidelines
- Be specific about file paths and components
- Consider parallelization opportunities
- Keep task descriptions concise but actionable

Note: For agents using CLI callback, completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete', 'apc task'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
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

    analyst_implementation: {
        id: 'analyst_implementation',
        name: 'Implement Analyst',
        description: 'Reviews plans for implementation feasibility, code quality, and dependency patterns',
        isBuiltIn: true,
        defaultModel: 'gpt-5.1-codex-high',
        timeoutMs: 600000,
        color: '#8b5cf6',  // Violet
        promptTemplate: `You are the Implementation Analyst (Architect) reviewing an execution plan.

## Your Role
Review the plan for implementation feasibility, code quality, and dependency patterns.

## What to Review

### 1. Implementation Feasibility (shared with Reviewer)
- Can the proposed tasks be implemented as described?
- Are the code changes realistic and well-scoped?
- Is the scope realistic for the timeline?

### 2. Performance Concerns (shared with Quality)
- Will the implementation have performance issues?
- Are there better approaches for performance-critical code?
- Hot paths identified and optimized?

### 3. Code Structure & Patterns (shared with Reviewer)
- Does the plan follow existing code patterns?
- Are there missing implementation details?
- Consistent naming and organization?

### 4. Technical Debt (shared with Quality)
- Will this create maintenance issues?
- Are there refactoring opportunities?
- Code duplication risks?

### 5. Edge Cases (shared with Quality)
- Are edge cases in implementation considered?
- Null checks, bounds checking, error states?

### 6. Integration Risks (shared with Reviewer)
- Will changes break existing code?
- Are integration points well-defined?

### 7. Dependency Strategy (shared with Reviewer) ⚠️ IMPORTANT
- **PREFERRED**: ServiceLocator pattern for dependency injection
- **AVOID**: Singleton pattern (hard to test, hidden dependencies)
- Flag any task proposing singleton patterns as CRITICAL
- Are dependencies explicit and injectable?

### 8. Task Breakdown Granularity (shared with ALL)
- Is any task too large (would take multiple sessions)?
- Can tasks be split for parallel execution?
- Is each task independently completable?

## Output Format (REQUIRED)

Write feedback INLINE in the plan using this format:
\`[Feedback from analyst_implementation][CRITICAL|MINOR] Your feedback here\`

Place feedback directly after the paragraph/task it relates to.

At the END of the plan, add a summary section:

\`\`\`markdown
---
## Feedback Summary: analyst_implementation

### Verdict: [PASS|CRITICAL|MINOR]

### Critical Issues
- [List blocking issues, or "None"]

### Minor Suggestions
- [List suggestions, or "None"]

### Task Breakdown Assessment
- [Are tasks appropriately sized? Any that need splitting?]

### Dependency Strategy Violations
- [Any singleton patterns to flag? Or "None - ServiceLocator used correctly"]

### Engineer Recommendation
- [Recommended engineer count and allocation notes]
\`\`\`

## Verdict Guidelines
- **PASS**: Implementation approach is solid, no blocking issues
- **CRITICAL**: Blocking issues (bad patterns, infeasible tasks, singleton usage)
- **MINOR**: Suggestions only, plan can proceed

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
            'Write feedback INLINE in the plan file',
            'Use [Feedback from analyst_implementation][LEVEL] prefix',
            'Flag singleton patterns as CRITICAL',
            'Prefer ServiceLocator for dependencies',
            'Be specific about file paths and issues',
            'Add summary section at end of plan'
        ],
        documents: [],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity-Specific Concerns
- Are Unity APIs used correctly?
- Are there frame-rate concerns (Update/FixedUpdate usage)?
- Is serialization handled properly for Unity objects?
- MonoBehaviour vs pure C# class decisions?`
    },

    analyst_quality: {
        id: 'analyst_quality',
        name: 'Quality Analyst',
        description: 'Reviews plans for testing strategy, quality assurance, and context needs',
        isBuiltIn: true,
        defaultModel: 'gpt-5.1-codex-high',
        timeoutMs: 600000,
        color: '#ec4899',  // Pink
        promptTemplate: `You are the Testing & Quality Analyst reviewing an execution plan.

## Your Role
Review the plan for testing completeness, quality assurance, and identify tasks needing context.

## What to Review

### 1. Performance Concerns (shared with Architect)
- Are performance-critical paths tested?
- Load testing or stress testing needed?

### 2. Technical Debt (shared with Architect)
- Test maintainability concerns?
- Are tests themselves creating debt?

### 3. Test Coverage (shared with Reviewer)
- Are there enough tests planned?
- Do tests cover the critical paths?
- Integration test strategy adequate?

### 4. Edge Cases (shared with Architect)
- Are edge cases identified and tested?
- Error handling paths covered?
- Boundary conditions tested?

### 5. Architecture Soundness (shared with Reviewer)
- Is testability considered in design?
- Can components be tested in isolation?
- Mock-friendly architecture?

### 6. Task Dependencies Ordering (shared with Reviewer)
- Does test order match implementation order?
- Are test dependencies explicit?

### 7. Task Breakdown Granularity (shared with ALL)
- Is each task independently testable?
- Are tasks sized appropriately for isolated testing?
- Can tests be written incrementally?

### 8. Context Gathering Needed (shared with Reviewer) ⚠️ IMPORTANT
- Which tasks touch unfamiliar code areas?
- Does engineer need to understand existing patterns first?
- Are there undocumented integration points?
- Check if _AiDevLog/Context/ has relevant documentation

Flag tasks needing context with: \`[NEEDS_CONTEXT: {SESSION_ID}_T3, {SESSION_ID}_T5]\`

## Unity Pipeline Requirements (IMPORTANT for Unity projects)

For each task, recommend the appropriate Unity pipeline configuration:

| Unity Config | When to Use |
|--------------|-------------|
| \`none\` | Documentation, README, non-Unity file changes |
| \`prep\` | C# code, assets, prefabs, ScriptableObjects (compile only) |
| \`prep_editmode\` | Adding/modifying EditMode tests |
| \`prep_playmode\` | Adding/modifying PlayMode tests |
| \`prep_playtest\` | Data/balance changes (damage values, spawn rates, input config) |
| \`full\` | Milestones, major features, release candidates |

Add to each task line: \`[unity: <config>]\`
Example: \`- [ ] T3: Add movement unit tests [unity: prep_editmode]\`

## Output Format (REQUIRED)

Write feedback INLINE in the plan using this format:
\`[Feedback from analyst_quality][CRITICAL|MINOR] Your feedback here\`

Place feedback directly after the paragraph/task it relates to.

At the END of the plan, add a summary section:

\`\`\`markdown
---
## Feedback Summary: analyst_quality

### Verdict: [PASS|CRITICAL|MINOR]

### Critical Issues
- [List blocking issues, or "None"]

### Minor Suggestions
- [List suggestions, or "None"]

### Test Strategy Assessment
- [Is test coverage adequate? Missing test types?]

### Task Breakdown Assessment
- [Are tasks independently testable?]

### Context Gathering Recommendation
- [NEEDS_CONTEXT: {SESSION_ID}_T2, {SESSION_ID}_T4] or "No context gathering needed"
- [Reason: e.g., "{SESSION_ID}_T2 touches legacy auth system with no docs"]

### Engineer Recommendation
- [Recommended engineer count and notes on testing expertise needed]
\`\`\`

## Verdict Guidelines
- **PASS**: Testing strategy is solid, context needs identified
- **CRITICAL**: Missing critical test coverage or unclear integration points
- **MINOR**: Suggestions for better coverage

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
            'Write feedback INLINE in the plan file',
            'Use [Feedback from analyst_quality][LEVEL] prefix',
            'Flag tasks needing context with [NEEDS_CONTEXT: Tx]',
            'Check _AiDevLog/Context/ for existing documentation',
            'Focus on testability and quality assurance',
            'Add summary section at end of plan'
        ],
        documents: ['_AiDevLog/Context/'],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity-Specific Testing
- Are Unity lifecycle methods properly tested?
- Is PlayMode testing needed for any features?
- Are EditMode tests sufficient, or do features need runtime testing?
- Consider MonoBehaviour initialization order
- Are coroutines and async operations tested?`,
        unityRules: ['Consider Unity-specific testing needs (PlayMode vs EditMode)']
    },

    // NOTE: error_analyst role removed - ErrorResolutionWorkflow now uses engineer role
    // for combined analyze+fix in a single AI session (fire-and-forget pattern)
    
    analyst_architecture: {
        id: 'analyst_architecture',
        name: 'Architect Analyst',
        description: 'Reviews plans for architecture, integration, dependency patterns, and planning quality',
        isBuiltIn: true,
        defaultModel: 'gpt-5.1-codex-high',
        timeoutMs: 600000,
        color: '#6366f1',  // Indigo
        promptTemplate: `You are the Architecture & Strategy Analyst reviewing an execution plan.

## Your Role
Review the plan for architectural soundness, integration strategy, and planning quality.

## What to Review

### 1. Implementation Feasibility (shared with Architect)
- Is the overall scope realistic?
- Are there architectural blockers?

### 2. Code Structure & Patterns (shared with Architect)
- Are architectural patterns appropriate?
- Consistent with existing codebase architecture?

### 3. Test Coverage (shared with Quality)
- Is integration test strategy adequate?
- Are architectural boundaries testable?

### 4. Architecture Soundness (shared with Quality)
- Does the plan follow good architectural principles?
- Are concerns properly separated?
- Is the design extensible?

### 5. Integration Risks (shared with Architect)
- How does this integrate with existing systems?
- Are there potential conflicts?
- System-level side effects?

### 6. Task Dependencies Ordering (shared with Quality)
- Are dependencies properly identified?
- Is the task ordering correct?
- Critical path identified?

### 7. Dependency Strategy (shared with Architect) ⚠️ IMPORTANT
- **PREFERRED**: ServiceLocator pattern for dependency injection
- **AVOID**: Singleton pattern (hard to test, hidden dependencies)
- Are dependencies properly abstracted?
- Can components be swapped/mocked?
- Flag singleton usage as CRITICAL

### 8. Task Breakdown Granularity (shared with ALL)
- Is the granularity appropriate for complexity?
- Are there missing intermediate tasks?
- Right level of detail for engineers?

### 9. Context Gathering Needed (shared with Quality) ⚠️ IMPORTANT
- Which areas lack documentation in _AiDevLog/Context/?
- Are there unfamiliar integration points?
- Should ContextGatheringWorkflow run before certain tasks?

Flag tasks needing context with: \`[NEEDS_CONTEXT: {SESSION_ID}_T2, {SESSION_ID}_T4]\`

## Output Format (REQUIRED)

Write feedback INLINE in the plan using this format:
\`[Feedback from analyst_architecture][CRITICAL|MINOR] Your feedback here\`

Place feedback directly after the paragraph/task it relates to.

At the END of the plan, add a summary section:

\`\`\`markdown
---
## Feedback Summary: analyst_architecture

### Verdict: [PASS|CRITICAL|MINOR]

### Critical Issues
- [List blocking issues, or "None"]

### Minor Suggestions
- [List suggestions, or "None"]

### Architecture Assessment
- [Is the architecture sound? Integration risks?]

### Dependency Strategy Violations
- [Any singleton patterns? Or "None - patterns are appropriate"]

### Task Breakdown Assessment
- [Is granularity appropriate? Missing tasks?]

### Context Gathering Recommendation
- [NEEDS_CONTEXT: {SESSION_ID}_T1, {SESSION_ID}_T6] or "No context gathering needed"
- [Reason: e.g., "{SESSION_ID}_T1 integrates with undocumented payment system"]

### Engineer Recommendation
- [Recommended engineer count, skill requirements, allocation strategy]
\`\`\`

## Verdict Guidelines
- **PASS**: Architecture is sound, plan is well-structured
- **CRITICAL**: Architectural issues, singleton abuse, or missing critical tasks
- **MINOR**: Suggestions for cleaner architecture

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write', 'grep', 'list_dir', 'codebase_search'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
            'Write feedback INLINE in the plan file',
            'Use [Feedback from analyst_architecture][LEVEL] prefix',
            'Flag singleton patterns as CRITICAL',
            'Prefer ServiceLocator for dependencies',
            'Flag tasks needing context with [NEEDS_CONTEXT: Tx]',
            'Check _AiDevLog/Context/ for gaps',
            'Add summary section at end of plan'
        ],
        documents: ['_AiDevLog/Context/'],
        // Unity-specific additions
        unityPromptAddendum: `
## Unity Architecture Concerns
- Are assembly definitions properly structured?
- Is the MonoBehaviour vs pure C# class split appropriate?
- Are ScriptableObject patterns used correctly?
- Consider Unity's execution order dependencies
- Is the Unity-specific singleton (like GameManager) justified?`
    },

    text_clerk: {
        id: 'text_clerk',
        name: 'Text Clerk',
        description: 'Lightweight agent for text formatting and cleanup tasks',
        isBuiltIn: true,
        defaultModel: 'auto',
        timeoutMs: 120000,  // 2 minutes - should be quick
        color: '#94a3b8',   // Slate gray - utility role
        promptTemplate: `You are a Text Clerk agent responsible for document formatting and cleanup.

## Your Role
You perform simple text formatting, cleanup, and structural adjustments to documents.
You do NOT create new content or make strategic decisions - you format existing content.

## Core Tasks
1. Ensure consistent formatting (headers, lists, checkboxes)
2. Fix structural issues (indentation, spacing)
3. Update status fields as directed
4. Ensure documents follow required format specifications

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`,
        allowedMcpTools: ['read_file', 'write'],
        allowedCliCommands: ['apc agent complete'],
        rules: [
            '🚨 MANDATORY: You MUST run `apc agent complete` command before finishing - workflow fails without it',
            'Only format - do not add new content',
            'Preserve all existing information',
            'Follow exact format specifications given',
            'Be fast and efficient'
        ],
        documents: []
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

    toJSON(): Record<string, unknown> {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        
        roleIntro: `You are the AI Coordinator Agent responsible for managing task execution across multiple plans.

Your job is to:
- Create and start tasks based on approved plans
- Maximize agent utilization (keep all available agents busy)
- Avoid creating duplicate tasks
- Respect task dependencies

⚠️ CRITICAL RULES:
1. You may ONLY create and start tasks for plans with status 'approved'.
2. NEVER create tasks or start workflows for plans with status 'reviewing', 'revising', 'planning', or any other non-approved status.
3. Only the plans listed in the "APPROVED PLANS" section below are allowed to have tasks created.
4. The system will REJECT any attempt to create tasks or start workflows for non-approved plans.`,

        decisionInstructions: `**Total Agents: {{AVAILABLE_AGENT_COUNT}}** | Session Capacities: {{SESSION_CAPACITIES}}

## Capacity Rules
1. **Per-Session Limit**: Never exceed session's recommended agent count
2. **Global 80% Rule**: (Active Workflows + 1) ≤ ({{AVAILABLE_AGENT_COUNT}} × 0.8)
3. **One workflow per task**: Check \`apc workflow list\` before starting

## Available Workflows
{{WORKFLOW_SELECTION}}

## CLI Commands Reference

| Command | Purpose |
|---------|---------|
| \`apc task list\` | List all tasks with status |
| \`apc task create --session <s> --id <id> --desc "..." --type <type> [--deps <s>_T1,<s>_T2] [--unity <config>]\` | Create task |
| \`apc task start --session <s> --id <id> --workflow <w>\` | Start workflow |
| \`apc task status --session <s> --id <id>\` | Check task status |
| \`apc task complete --session <s> --id <id>\` | Mark complete |
| \`apc task fail --session <s> --id <id>\` | Mark failed |
| \`apc task add-dep --session <s> --task <id> --depends-on <depId>\` | Add dependency |
| \`apc workflow list [sessionId]\` | List active workflows |
| \`apc workflow resume --session <s> --workflow <w>\` | Resume paused workflow |
| \`apc workflow pause --session <s> --workflow <w>\` | Pause running workflow |
| \`apc workflow cancel --session <s> --workflow <w>\` | Cancel stuck workflow |
| \`apc workflow summarize --session <s> --workflow <w> --summary "..."\` | Record summary |

## ⚠️ Critical Rules

### Task IDs: STRICT GLOBAL UPPERCASE format (REQUIRED)
Format: \`PS_XXXXXX_TN\` — e.g., \`PS_000001_T1\`, \`PS_000001_T2\`, \`PS_000001_CTX1\`
**Simple IDs like "T1" are NOT accepted.** Always use the full global format.
All IDs are normalized to UPPERCASE internally.

### Dependencies
- Must exist before creating dependent tasks (create in order: PS_000001_T1 first, then PS_000001_T2)
- **Must use global IDs**: \`--deps PS_000001_T1\` (same session) or \`--deps PS_000002_T5\` (cross-plan)
- Simple IDs like "T1" are NOT accepted in dependencies

### Task Types
\`implementation\` | \`error_fix\` — No other values

### Unity Pipeline (--unity flag)
Set per-task Unity verification. Look for \`[unity: <config>]\` annotations in plan tasks:
| Config | When to Use |
|--------|-------------|
| \`none\` | Docs, README, non-Unity files |
| \`prep\` | Code/assets (compile only) |
| \`prep_editmode\` | EditMode tests |
| \`prep_playmode\` | PlayMode tests |
| \`prep_playtest\` | Data/balance changes |
| \`full\` | Milestones, major features |

**Default**: \`prep_editmode\` if not specified

### Task Status Flow
\`created\` → can start | \`blocked\` → waiting on deps | \`in_progress\` → workflow running | \`awaiting_decision\` → workflow done, you decide | \`completed\`/\`failed\` → terminal

**\`awaiting_decision\`**: Workflow finished. Check result and either:
- Mark \`apc task complete\` if work is done
- Start another workflow if more work needed
- Mark \`apc task fail\` if unrecoverable

### Stuck/Paused Workflow Handling
Check \`workflowHealth\` in context for issues:
- \`task_completed\`: Orphan workflow — task done, cancel with \`apc workflow cancel\`
- \`paused\`: Workflow paused — use \`apc workflow resume --session <s> --workflow <w>\`
- \`no_activity\`: No progress 10+ min — check logs, cancel if unresponsive
- \`waiting_for_agent\`: Pool exhausted — wait or reduce parallel workflows
- \`agents_idle\`: Agents allocated but idle — investigate or cancel/restart

## Execution Steps

1. **Handle awaiting_decision tasks FIRST** — Check AWAITING YOUR DECISION section, mark complete/fail or start new workflow
2. **Resume paused workflows** — Check PAUSED - CAN RESUME section, resume any paused workflows with \`apc workflow resume\`
3. \`apc task list\` — Check existing tasks
4. \`apc workflow list\` — Check active workflows  
5. Verify capacity (session + global 80% rule)
6. Read plan files to identify needed tasks
7. Create ONLY ready-to-start tasks (max {{AVAILABLE_AGENT_COUNT}}, deps already met)
8. Start all created tasks immediately (chain with &&)
9. On \`workflow_completed\` event: write summary with \`apc workflow summarize\`

**⚠️ IMPORTANT**: Always check for paused workflows before starting new ones. Resuming existing work is more efficient than starting fresh.

**Example (create + start):**
\`\`\`bash
apc task create --session ps_000001 --id ps_000001_T1 --desc "First task" --type implementation && \\
apc task start --session ps_000001 --id ps_000001_T1 --workflow task_implementation
\`\`\`

## Cross-Plan Conflicts
When CROSS-PLAN FILE CONFLICTS section shows overlapping files, add dependencies:
\`\`\`bash
apc task add-dep --session ps_000001 --task ps_000001_T3 --depends-on ps_000002_T5
\`\`\`

## Response Format
After executing, provide:
REASONING: <What was done and why. Tasks left for later.>
CONFIDENCE: <0.0-1.0>`
    },
    
    // Unity Polling is configured in Unity settings page, not in System Prompts
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
    },
    
    new_plan: {
        id: 'new_plan',
        name: 'New Plan Agent',
        description: 'Creates new implementation plans from user requests',
        category: 'planning',
        defaultModel: 'sonnet-4.5',
        promptTemplate: `You are the New Plan Agent responsible for creating implementation plans from user requests.

Your job is to:
1. Analyze the user's feature request or goal
2. Break down complex features into manageable tasks
3. Identify dependencies between tasks
4. Create a structured plan with clear objectives
5. Estimate effort and recommend team size

Guidelines:
- Be thorough in understanding requirements
- Create tasks that are specific and actionable
- Consider edge cases and error handling
- Include testing and validation tasks
- Keep tasks appropriately sized (not too large or small)`
    },
    
    revise_plan: {
        id: 'revise_plan',
        name: 'Revise Plan Agent',
        description: 'Revises and improves existing plans based on feedback',
        category: 'planning',
        defaultModel: 'sonnet-4.5',
        promptTemplate: `You are the Revise Plan Agent responsible for revising existing implementation plans.

Your job is to:
1. Review the existing plan and feedback
2. Identify areas that need improvement
3. Restructure tasks based on new requirements
4. Update dependencies and task ordering
5. Incorporate lessons learned from execution

Guidelines:
- Preserve completed work and progress
- Address specific feedback points
- Maintain consistency with project goals
- Update estimates if scope has changed
- Consider impact on dependent tasks`
    },
    
    cli_nudge: {
        id: 'cli_nudge',
        name: 'CLI Completion Nudge',
        description: 'Fast recovery session when agent forgets to call CLI completion command',
        category: 'utility',
        defaultModel: 'haiku-3.5',
        promptTemplate: `You must call the CLI completion command. A previous agent session completed work but forgot to call it.

## Your ONLY Task
Read the log file below to understand what was done, then run the completion command.

## Log File (read this first)
{{LOG_FILE_PATH}}

## Completion Command (run this after reading log)
\`\`\`bash
{{CLI_COMMAND}}
\`\`\`

## Result Options
Choose based on what the log shows: {{RESULT_OPTIONS}}

DO NOT do any other work. Just: 1) read_file the log, 2) run the CLI command.`
    }
};

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
    available: string[];  // Pool agents (idle)
    allocated: Record<string, AllocatedAgentInfo>;  // On bench (waiting for promotion)
    busy: Record<string, BusyAgentInfo>;  // Working on workflows (actively running)
    resting: Record<string, RestingAgentInfo>;  // Cooldown after release (5 seconds)
}

export interface AllocatedAgentInfo {
    sessionId: string;
    workflowId: string;  // REQUIRED: the workflow that owns this agent on bench
    roleId: string;
    allocatedAt: string;
}

export interface BusyAgentInfo {
    sessionId: string;
    roleId: string;
    workflowId: string;  // REQUIRED - the workflow this agent is working on
    task?: string;
    startTime: string;
    processId?: number;
    logFile?: string;
}

export interface RestingAgentInfo {
    releasedAt: string;
    restUntil: string;  // ISO timestamp when agent can be allocated again
}

export interface AgentStatus {
    name: string;
    roleId?: string;
    status: 'available' | 'allocated' | 'busy' | 'resting' | 'paused' | 'error';
    sessionId?: string;
    workflowId?: string;  // The specific workflow this agent is working on
    task?: string;
    logFile?: string;
    processId?: number;
    restUntil?: string;  // ISO timestamp for resting agents
}

// ============================================================================
// Planning Session Types
// ============================================================================

export interface PlanningSession {
    id: string;
    status: PlanStatus;
    requirement: string;
    currentPlanPath?: string;
    planHistory: PlanVersion[];
    revisionHistory: RevisionEntry[];
    recommendedAgents?: AgentRecommendation;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, any>;  // Optional metadata for pause/resume state
    
    // === Execution State (simplified - occupancy tracked in global TaskManager) ===
    execution?: ExecutionState;
}

/**
 * Plan lifecycle status - tracks the plan document state only
 * Workflow states (running, paused, failed) are shown on individual workflows, not here.
 * 
 * - no_plan: No plan exists yet
 * - planning: planning_new workflow is active (creating plan)
 * - revising: planning_revision workflow is active
 * - reviewing: Plan ready for user review/approval
 * - approved: Plan approved, execution can proceed
 * - completed: All tasks done
 */
export type PlanStatus = 
    | 'no_plan'
    | 'planning'
    | 'revising'
    | 'reviewing'
    | 'approved'
    | 'completed';

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
 * Execution state embedded in PlanningSession (simplified)
 * 
 * Task occupancy is tracked globally in TaskManager (not duplicated here).
 * Workflow state is tracked by the coordinator and individual workflows.
 * This only contains minimal metadata for UI display.
 */
export interface ExecutionState {
    startedAt: string;
    lastActivityAt: string;
    
    /** Task progress snapshot for UI display */
    progress: TaskProgress;
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
    status: PlanStatus;
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
        status: PlanStatus;
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
        allocated: Array<{
            name: string;
            roleId: string;
            sessionId: string;
            workflowId: string;
        }>;
        busy: Array<{
            name: string;
            roleId?: string;
            coordinatorId: string;
            sessionId: string;
            task?: string;
        }>;
        resting: string[];
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
