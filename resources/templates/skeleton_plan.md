# Plan: {{PLAN_TITLE}}

**Session ID:** {{SESSION_ID}}
**Created:** {{CREATED_DATE}}
**Status:** 🔄 Planning

---

## 1. Requirement Summary

{{REQUIREMENT_SUMMARY}}

---

## 2. Context Analysis

### Codebase Context
<!-- Analysts fill this section with relevant findings -->

### Dependencies & Constraints
<!-- List any dependencies, blockers, or constraints -->

---

## 3. Analyst Discussion

### 🏗️ Opus Analyst (Architecture)
**Status:** ⏳ Analyzing...

<!-- Architecture recommendations, patterns, concerns -->

---

### ⚡ Codex Analyst (Implementation)
**Status:** ⏳ Analyzing...

<!-- Implementation details, performance concerns, code patterns -->

---

### 🧪 Gemini Analyst (Testing)
**Status:** ⏳ Analyzing...

<!-- Testing strategy, edge cases, validation approach -->

---

## 4. Consensus

### Agreed Approach
<!-- Summary of agreed approach after analyst discussion -->

### Engineer Count
**Recommended:** {{ENGINEER_COUNT}} engineers
**Rationale:** <!-- Why this number -->

---

## 5. Task Checklist

<!-- 
IMPORTANT: Tasks MUST use checkbox format for tracking
Format: - [ ] **T{N}**: {Task Name} | Deps: {dependencies} | Engineer: {name}
-->

### Phase 1: Foundation
- [ ] **T1**: {{TASK_1_NAME}} | Deps: None | Engineer: TBD
- [ ] **T2**: {{TASK_2_NAME}} | Deps: T1 | Engineer: TBD

### Phase 2: Core Implementation
- [ ] **T3**: {{TASK_3_NAME}} | Deps: T1 | Engineer: TBD
- [ ] **T4**: {{TASK_4_NAME}} | Deps: T2, T3 | Engineer: TBD

### Phase 3: Integration & Testing
- [ ] **T5**: {{TASK_5_NAME}} | Deps: T4 | Engineer: TBD

---

## 6. Dependency Graph

```
T1 ────┬───> T2 ───> T4 ───> T5
       │
       └───> T3 ───────┘
```

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| <!-- Risk 1 --> | Low/Med/High | Low/Med/High | <!-- Mitigation --> |

---

## 8. Success Criteria

- [ ] All tasks completed
- [ ] Tests passing
- [ ] Code reviewed
- [ ] Documentation updated

---

<!-- PLAN_METADATA
session_id: {{SESSION_ID}}
created: {{CREATED_DATE}}
status: planning
revision: v1
analysts: opus,codex,gemini
engineer_count: {{ENGINEER_COUNT}}
-->

