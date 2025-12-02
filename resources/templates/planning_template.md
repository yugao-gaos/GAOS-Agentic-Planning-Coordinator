# Planning Workflow Configuration

## Settings
max_iterations: 3
exit_condition: no_critical_issues

## Analyst Output Format

Analysts must output their review in this format:

```markdown
### Review Result: PASS | CRITICAL | MINOR

#### Critical Issues
- [List blocking issues or "None"]

#### Minor Suggestions
- [List suggestions or "None"]

#### Analysis
[Detailed analysis]
```

- **PASS**: No issues found, approve plan
- **CRITICAL**: Blocking issues that must be fixed before proceeding
- **MINOR**: Suggestions only, can proceed without changes

## Planning Tasks

### Phase 0: Context Preparation
- **context**: Gather Project Context | Role: context_gatherer
  - Scans codebase structure and patterns
  - Identifies Unity components and setup
  - Documents dependencies and integration points

### Phase 1: Initial Plan (Iterative)
- **plan**: Write/Update Plan | Role: planner
  - Creates initial plan from skeleton template (iteration 1)
  - Updates plan based on analyst feedback (iteration 2+)

### Phase 2: Analyst Review (Parallel)
- **review_codex**: Implementation Review | Role: analyst_codex
  - Reviews implementation feasibility
  - Checks performance concerns
  - Validates code structure
  
- **review_gemini**: Testing Review | Role: analyst_gemini
  - Reviews testing strategy
  - Identifies edge cases
  - Validates test coverage

- **review_arch**: Architecture Review | Role: analyst_reviewer
  - Reviews architectural soundness
  - Checks integration with existing code
  - Assesses risks

### Phase 3: Finalization
- **finalize**: Finalize Plan | Role: planner
  - Incorporates minor suggestions
  - Ensures correct task format
  - Notes any unresolved warnings

## Loop Logic

```
P0: Context
     │
     ▼
┌────────────────────────────────┐
│  P1: Planner creates/updates   │◄──┐
│         │                      │   │
│    ┌────┴────┬────────┐       │   │ (max 3)
│    ▼         ▼        ▼       │   │
│  Codex    Gemini   Reviewer   │   │
│    │         │        │       │   │
│    └────┬────┴────────┘       │   │
│         ▼                      │   │
│  [Any CRITICAL?]───Yes─────────┼───┘
│         │No                    │
│         ▼                      │
│  P3: Finalize                  │
└────────────────────────────────┘
```

## Revision Flow

When user provides feedback, revision is a single pass:

```
User Feedback → Planner updates → Codex reviews → Planner finalizes
```

Only Codex analyst reviews during revision (faster than full 3-analyst review).






















