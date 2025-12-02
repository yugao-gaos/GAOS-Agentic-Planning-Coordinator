# Error Investigation Summary
**Date:** December 2, 2025  
**Status:** ✅ Investigation Complete

## TL;DR

The daemon errors are **non-critical symptoms of normal operation** in a long-running system. The main issues are:

1. **Workflow Not Found** - UI queries workflows that were cleaned up (1-hour TTL)
2. **Task Not Found with `--session`** - CLI argument parsing issue (✅ **FIXED**)
3. **Rapid Client Connections** - Possible duplicate VS Code instances or aggressive reconnect logic

## What I Fixed

✅ **CLI Script** - Updated `scripts/apc` to support both positional and named parameters for `task status`:
- `apc task status ps_000001 T1` ← still works
- `apc task status --session ps_000001 --task T1` ← now works too

## Root Causes Identified

### 1. Workflow Lifecycle Mismatch
- **Backend:** Workflows kept for 1 hour, then cleaned up
- **Frontend:** UI caches workflow IDs indefinitely
- **Result:** UI queries cleaned-up workflows → errors logged

**Why it happens:**
```
1. User completes workflow at 2:00 PM
2. User leaves VS Code open
3. At 3:01 PM, coordinator cleans up workflow
4. UI refreshes at 3:05 PM, tries to query workflow
5. Error: "Workflow 410392e6 not found"
```

### 2. No Cleanup Events
- Backend cleans up workflows silently
- UI never knows workflows were removed
- UI keeps trying to query them

### 3. Client Connection Churn
- Multiple VS Code instances?
- Health check connections?
- Aggressive reconnect logic?

## Recommended Fixes (Priority Order)

### P0 - Immediate (Quick Wins)
1. ✅ **CLI argument parsing fix** (already done)
2. **Graceful 404 handling** - Return "not_found" status instead of throwing error
3. **Emit cleanup events** - Broadcast when workflows are cleaned up

### P1 - Short Term (This Week)
4. **UI cleanup on completion** - Remove workflow from tracked list when complete
5. **Status query cache** - Cache workflow status for 5s to reduce queries
6. **Connection singleton** - Prevent duplicate VS Code clients

### P2 - Medium Term (Next Sprint)
7. **Workflow state machine** - Explicit `active`/`archived`/`removed` states
8. **History service** - Move old workflows to persistent storage
9. **Client identification** - Add process PID to client ID for debugging

## Files Modified

- ✅ `scripts/apc` - Fixed task status command
- 📝 `_AiDevLog/ERROR_INVESTIGATION.md` - Initial findings
- 📝 `_AiDevLog/ERROR_INVESTIGATION_DETAILED.md` - Deep dive analysis

## Next Steps

1. **Review detailed report:** `_AiDevLog/ERROR_INVESTIGATION_DETAILED.md`
2. **Implement P0 fixes:** Graceful 404 handling + cleanup events
3. **Test with overnight session:** Verify no more "not found" errors
4. **Monitor logs:** Track connection churn patterns

## Key Insights

- The system is **working as designed** - errors are edge cases
- Workflows **should** be cleaned up (prevents memory leaks)
- UI just needs to **know** when cleanup happens
- Most fixes are **synchronization**, not architecture changes

## Questions to Investigate Next

- [ ] Are there multiple VS Code instances running?
- [ ] What triggers the rapid reconnections (code 1005)?
- [ ] Can we add metrics to track these patterns?
- [ ] Should we increase the 1-hour TTL for completed workflows?

---

See detailed analysis in `ERROR_INVESTIGATION_DETAILED.md` for code references, implementation examples, and testing plans.



