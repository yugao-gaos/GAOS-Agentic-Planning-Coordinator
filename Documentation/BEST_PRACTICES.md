# Development Best Practices

This document outlines core development principles for the GAOS Agentic Planning Coordinator project.

---

## 🚨 #1 MOST IMPORTANT: NO FALLBACK LOGIC

**Never create fallback logic that masks errors or provides alternative data sources.**

### Why This Matters

Fallback logic creates several critical problems:

1. **Masks Real Errors** - When something fails, fallbacks hide the failure, making debugging impossible
2. **Client-Daemon Inconsistency** - Client shows fallback data while daemon shows actual state, creating confusion
3. **False Sense of Success** - Operations appear to work when they're actually failing
4. **Debugging Nightmare** - Users can't tell what's actually broken vs what's working

### The Rule

**If something fails, LET IT FAIL VISIBLY.**

- ❌ Don't return empty arrays when data fetch fails
- ❌ Don't use cached/stale data when fresh data unavailable  
- ❌ Don't silently switch between data sources (daemon → local files)
- ❌ Don't use default values when required values are missing
- ❌ Don't guess or assume values when detection fails

### What To Do Instead

✅ **Throw descriptive errors**
```typescript
// BAD
try {
    return await fetchData();
} catch {
    return []; // Masks the error!
}

// GOOD
try {
    return await fetchData();
} catch (error) {
    throw new Error(`Failed to fetch data: ${error.message}`);
}
```

✅ **Show "not available" states in UI**
```typescript
// BAD
const data = daemonData || localFileData; // Hides daemon failure

// GOOD
if (!daemonConnected) {
    throw new Error('Daemon not connected. Cannot fetch data.');
}
return daemonData;
```

✅ **Log failures with context before throwing**
```typescript
// GOOD
try {
    return await operation();
} catch (error) {
    log.error(`Operation failed - Context: ${context}`, error);
    throw error; // Re-throw, don't hide it
}
```

### Single Source of Truth

Each piece of data should have ONE authoritative source:

- ❌ If daemon has the data, don't also check local files as fallback
- ❌ If role doesn't exist, don't fallback to different role
- ✅ Fail fast when source is unavailable
- ✅ Show clear error: "Daemon disconnected" not silent fallback

---

## 2. Explicit Error Handling

### Always Surface Errors

Errors are valuable information for users and developers. Never hide them.

**Principles:**
- Throw descriptive errors with context
- Log failures before throwing
- Return error states in API responses (don't mask with success + empty data)
- UI should display error messages prominently

**Example:**
```typescript
// BAD
catch (error) {
    console.log('Error occurred');
    return null;
}

// GOOD  
catch (error) {
    log.error('Failed to initialize service:', error);
    throw new Error(`Service initialization failed: ${error.message}. Check logs for details.`);
}
```

### Error Messages Should Be Actionable

Tell users WHAT failed and HOW to fix it:

```typescript
// BAD
throw new Error('Failed');

// GOOD
throw new Error('Unity MCP connection failed: Unity Editor not running. Please start Unity and ensure MCP server is configured.');
```

---

## 3. Client-Daemon Consistency

Client and daemon MUST show identical results. No exceptions.

### Rules

- **No local fallbacks** when daemon is unavailable
- **Show connection status** clearly in UI  
- **Fail operations** when daemon is required but disconnected
- **Single source of truth** - daemon is authoritative for runtime state

### Example

```typescript
// BAD - Silent fallback creates inconsistency
async function getConfig() {
    if (daemonConnected) {
        return await daemonClient.getConfig();
    }
    return loadConfigFromFile(); // Different data source!
}

// GOOD - Explicit requirement
async function getConfig() {
    if (!daemonConnected) {
        throw new Error('Daemon not connected. Cannot fetch configuration.');
    }
    return await daemonClient.getConfig();
}
```

---

## 4. Common Anti-Patterns to Avoid

### ❌ Empty Array/Object Returns on Error

```typescript
// BAD
catch { return []; }
catch { return {}; }
catch { return null; }

// GOOD
catch (error) { 
    throw new Error(`Operation failed: ${error}`); 
}
```

### ❌ Nullish Coalescing for Required Values

```typescript
// BAD - Hides missing required values
const roleId = requestedRole || 'engineer' || availableRoles[0];

// GOOD
if (!requestedRole) {
    throw new Error('Role ID is required');
}
if (!roleRegistry.hasRole(requestedRole)) {
    throw new Error(`Role '${requestedRole}' not found in registry`);
}
```

### ❌ Try-Catch-Ignore

```typescript
// BAD - Swallows all errors
try {
    await criticalOperation();
} catch {
    // Silently ignore, operation appears successful
}

// GOOD
try {
    await criticalOperation();
} catch (error) {
    log.error('Critical operation failed:', error);
    throw error;
}
```

### ❌ Silent Data Source Switching

```typescript
// BAD - User doesn't know which source they're seeing
const settings = await daemon.getSettings() || loadLocalSettings();

// GOOD
if (!daemon.isConnected()) {
    throw new Error('Cannot load settings: daemon not connected');
}
return await daemon.getSettings();
```

---

## 5. When Defaults ARE Acceptable

Some use cases DO allow defaults, but they must be **explicit and intentional**:

### ✅ Optional Configuration with Documented Defaults

```typescript
interface Options {
    timeout?: number; // Defaults to 5000ms if not provided
    retries?: number; // Defaults to 3 if not provided
}

function operation(options: Options = {}) {
    const timeout = options.timeout ?? 5000; // Explicit default for optional param
    const retries = options.retries ?? 3;    // Clear that this is optional
    // ...
}
```

### ✅ UI Display Preferences

```typescript
// User preferences for display, not critical data
const theme = userPrefs.theme || 'dark'; // OK - display preference
const pageSize = userPrefs.pageSize || 20; // OK - pagination default
```

### ❌ Critical Business Data

```typescript
// NEVER use defaults for:
const userId = session.userId || 'anonymous'; // NO! Need real user
const taskStatus = task.status || 'pending';  // NO! Need actual status
const agentRole = requested.role || 'engineer'; // NO! Need specific role
```

---

## 6. Testing Error Paths

When implementing features, test the error paths as thoroughly as success paths:

- Test with daemon disconnected
- Test with missing dependencies
- Test with invalid inputs
- Test with permission errors
- Verify error messages are clear and actionable

---

## Summary

**Core Principle: Fail Fast, Fail Loud, Fail Clear**

1. **NO FALLBACK LOGIC** - Most important rule
2. Never mask errors with empty returns
3. Single source of truth for each data type
4. Show "not available" instead of stale data
5. Client and daemon must match
6. Make errors visible and actionable

**When in doubt, ask: "If this fails, will the user know what went wrong?"**

If the answer is no, you're hiding the error. Fix it.

