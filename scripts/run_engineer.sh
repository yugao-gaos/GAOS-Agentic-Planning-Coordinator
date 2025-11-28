#!/bin/bash
# Engineer session for macOS with background execution and log file
# Usage: bash run_engineer.sh [--headless] [--log-file <path>] <engineer_name> <plan_file_path> [additional_instruction] [max_runtime_seconds]
#
# Options:
#   --headless         Run without tailing log (for coordinator/automation use)
#   --log-file <path>  Use specified log file path (used by coordinator)
#
# ⚠️ IMPORTANT: DO NOT create new shell scripts for workflow control!
# Engineers should delegate Unity operations to the UnityControlAgent:
#   - Unity compilation: Request via CoordinatorService.requestCompilation()
#   - Unity tests: Request via UnityControlAgent task queue
#   - Unity state: Query via Unity MCP tools
# Engineers should use Unity MCP tools, NOT create new automation scripts.

# Parse options
HEADLESS_MODE=false
CUSTOM_LOG_FILE=""

while [[ "$1" == --* ]]; do
  case "$1" in
    --headless)
      HEADLESS_MODE=true
      shift
      ;;
    --log-file)
      CUSTOM_LOG_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 [--headless] [--log-file <path>] <engineer_name> <plan_file_path> [additional_instruction] [max_runtime_seconds]"
  echo ""
  echo "Options:"
  echo "  --headless         Run without tailing log (for coordinator/automation use)"
  echo "  --log-file <path>  Use specified log file path (used by coordinator)"
  echo ""
  echo "Examples:"
  echo "  $0 \"Alex\" \"_AiDevLog/Plans/Match3ImplementationPlan.md\""
  echo "  $0 \"Alex\" \"_AiDevLog/Plans/Match3ImplementationPlan.md\" \"Fix the gem spawning bug\""
  echo "  $0 --headless --log-file \"/path/to/log.log\" \"Alex\" \"Plan.md\" \"Task\" 3600"
  exit 1
fi

ENGINEER_NAME="$1"
PLAN_FILE="$2"

# Smart argument parsing: check if 3rd arg is numeric (max_runtime) or text (additional instruction)
if [ $# -ge 3 ]; then
  if [[ "$3" =~ ^[0-9]+$ ]]; then
    # 3rd arg is numeric, treat as max_runtime_seconds
    ADDITIONAL_INSTRUCTION=""
    MAX_RUNTIME_SECONDS="$3"
  else
    # 3rd arg is text, treat as additional instruction
    ADDITIONAL_INSTRUCTION="$3"
    MAX_RUNTIME_SECONDS=${4:-3600}  # 4th arg or default to 1 hour
  fi
else
  ADDITIONAL_INSTRUCTION=""
  MAX_RUNTIME_SECONDS=3600
fi

DOCS_FOLDER="_AiDevLog/Docs"
LOG_DIR="_AiDevLog/Logs/engineers"

# Use custom log file if provided, otherwise generate one
if [ -n "$CUSTOM_LOG_FILE" ]; then
  LOG_FILE="$CUSTOM_LOG_FILE"
  # Extract session ID from log file name if possible
  SESSION_ID=$(basename "$LOG_FILE" .log | sed "s/^${ENGINEER_NAME}_//" | head -c 10)
else
  # Find next available session number (incremental)
  SESSION_NUM=0
  while [ -f "${LOG_DIR}/${ENGINEER_NAME}_$(printf "%06d" $SESSION_NUM).log" ]; do
    SESSION_NUM=$((SESSION_NUM + 1))
  done
  SESSION_ID=$(printf "%06d" $SESSION_NUM)
  LOG_FILE="${LOG_DIR}/${ENGINEER_NAME}_${SESSION_ID}.log"
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Set terminal window title with engineer name and session ID
# Uses escape sequence: \033]0;TITLE\007
printf '\033]0;%s_%s\007' "${ENGINEER_NAME}" "${SESSION_ID}"

# Cleanup function
cleanup() {
  pkill -f "cursor agent.*$ENGINEER_NAME" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Record start time and create log file with header
START_TIME=$(date +%s)
> "$LOG_FILE"

# Write session header
echo "========================================" | tee -a "$LOG_FILE"
echo "Engineer: $ENGINEER_NAME" | tee -a "$LOG_FILE"
echo "Session ID: $SESSION_ID" | tee -a "$LOG_FILE"
echo "Start Time: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
echo "Plan: $PLAN_FILE" | tee -a "$LOG_FILE"
if [ -n "$ADDITIONAL_INSTRUCTION" ]; then
  echo "Focus: $ADDITIONAL_INSTRUCTION" | tee -a "$LOG_FILE"
fi
echo "Max Runtime: ${MAX_RUNTIME_SECONDS}s" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# List previous sessions for context
PREV_SESSIONS=$(ls -1 "${LOG_DIR}/engineer_${ENGINEER_NAME}_session_"*.log 2>/dev/null | grep -v "$LOG_FILE" | wc -l | tr -d ' ')
if [ "$PREV_SESSIONS" -gt 0 ]; then
  echo "📚 Previous Sessions Available: $PREV_SESSIONS" | tee -a "$LOG_FILE"
  echo "   You can read previous logs to understand context:" | tee -a "$LOG_FILE"
  ls -1 "${LOG_DIR}/engineer_${ENGINEER_NAME}_session_"*.log 2>/dev/null | grep -v "$LOG_FILE" | tail -n 3 | while read prev_log; do
    echo "   - $prev_log" | tee -a "$LOG_FILE"
  done
  echo "" | tee -a "$LOG_FILE"
fi

echo "[$ENGINEER_NAME] 🚀 Starting session with model: sonnet-4.5" | tee -a "$LOG_FILE"

# ANSI color codes
COLOR_THINKING='\033[0;36m'    # Cyan for thinking
COLOR_RESPONSE='\033[0;32m'    # Green for response text
COLOR_TOOL='\033[0;33m'        # Yellow for tool calls
COLOR_RESET='\033[0m'          # Reset color

# Unity Testing/Debugging Workflow Instructions (common for all engineers)
UNITY_WORKFLOW="

### Unity Editor Operations - DELEGATED TO COORDINATOR

**⚠️ CRITICAL: DO NOT directly access Unity Editor!**
All Unity operations go through the Coordinator → Unity Control Agent.
This ensures only ONE operation runs at a time across ALL engineers.

**When You Need Unity Compilation/Testing:**
1. Write a request marker in your output:
   - For compilation: Write 'UNITY_REQUEST:compile' on its own line
   - For EditMode tests: Write 'UNITY_REQUEST:test_editmode' on its own line
   - For PlayMode tests: Write 'UNITY_REQUEST:test_playmode' on its own line

2. The Coordinator will detect your request and queue it with Unity Control Agent

3. Wait for notification in your log file:
   - '✅ UNITY OPERATION COMPLETE' means success, continue your task
   - '⚠️ ERROR ASSIGNED TO YOU' means you have errors to fix

4. DO NOT try to focus Unity, exit playmode, or run tests yourself!

**CRITICAL: Unity .meta Files**
- **NEVER create .meta files manually**
- **NEVER write .meta files using any tools**
- Unity automatically generates .meta files for all assets
- Creating .meta files manually causes GUID conflicts and asset corruption

---

### Error Registry - MUST CHECK BEFORE FIXING

**Location:** \`_AiDevLog/Errors/error_registry.md\`

**BEFORE fixing ANY error:**
1. Read the error registry file
2. Find your assigned error by ID
3. Check the status:
   - ⏳ PENDING: You can claim it
   - 🔧 FIXING (by someone else): DO NOT TOUCH IT
   - 🔧 FIXING (by you): Continue working
   - ✅ FIXED: Skip, already done

**When you START fixing an error:**
Edit the error registry to update YOUR error entry:
\`\`\`
- **Status**: 🔧 FIXING
- **Started By**: $ENGINEER_NAME
- **Started At**: [current time]
\`\`\`

**When you FINISH fixing an error:**
Edit the error registry to update YOUR error entry:
\`\`\`
- **Status**: ✅ FIXED
- **Fixed By**: $ENGINEER_NAME
- **Fixed At**: [current time]
- **Fix Summary**: [brief description of what you changed]
\`\`\`

Then write 'UNITY_REQUEST:compile' to verify the fix.

**If you CANNOT fix an error:**
- Add notes explaining what you tried
- Set status back to ⏳ PENDING
- The coordinator will reassign it

---

### Task Completion Workflow

0. **FIRST:** Read previous session logs from ${LOG_DIR}/, read context docs and existing docs relevant to your task
1. Implement your assigned task
2. Write 'UNITY_REQUEST:compile' to trigger compilation
3. Wait for result notification in your log
4. If errors: Check error registry, fix assigned errors
5. If success: **UPDATE DOCUMENTATION**
   - Prefer updating existing docs over creating new ones
   - For new systems: add new doc in _AiDevLog/Docs/
   - Write a brief summary of what you changed in your log
   - (Context will be updated automatically by the coordinator's context agent)
6. Mark your checkbox [x] in the plan file, then continue to next task or write 'BLOCKED: [reason]' if stuck

**Session Context:**
- This is session $SESSION_ID for engineer $ENGINEER_NAME
- Previous session logs are available in ${LOG_DIR}/ - read them for context
- Check previous logs if you encounter issues that might have been solved before
"

# Best practices document path
# Default: Use extension's bundled UnityBestPractices.md
# Can be overridden via APC_BEST_PRACTICES_PATH environment variable
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_BEST_PRACTICES="${SCRIPT_DIR}/../resources/UnityBestPractices.md"

if [ -n "$APC_BEST_PRACTICES_PATH" ] && [ -f "$APC_BEST_PRACTICES_PATH" ]; then
  # Custom path from settings
  BEST_PRACTICES_FILE="$APC_BEST_PRACTICES_PATH"
elif [ -f "$EXTENSION_BEST_PRACTICES" ]; then
  # Extension's bundled file (default)
  BEST_PRACTICES_FILE="$EXTENSION_BEST_PRACTICES"
else
  # Fallback - shouldn't happen if extension is properly installed
  BEST_PRACTICES_FILE="UnityBestPractices.md"
  echo "⚠️ Warning: Could not find UnityBestPractices.md at expected location"
  echo "   Expected: $EXTENSION_BEST_PRACTICES"
fi

# Build the prompt based on whether additional instruction is provided
if [ -n "$ADDITIONAL_INSTRUCTION" ]; then
  PROMPT="You are $ENGINEER_NAME. 

🎯 PRIMARY FOCUS: $ADDITIONAL_INSTRUCTION

Reference the overall plan at $PLAN_FILE for context.
You have unityMCP available for reading Unity state (but NOT for controlling it directly).

📚 **REQUIRED: Read Unity Best Practices First**
Before implementing ANY task, you MUST read this file:
\`$BEST_PRACTICES_FILE\`

Use read_file tool to read it NOW. Key sections:
- Section 6: Testing - Don't over-test! Match test type to task type
- Section 7: Prototyping - Placeholders must match final tech stack  
- Section 2: Asset Management - Never create .meta files manually

$UNITY_WORKFLOW

**Your Workflow:**
0. **FIRST:** Read previous session logs from _AiDevLog/Logs/engineers/, read context and existing docs for your task
1. Read the best practices doc for guidance relevant to your task
2. Implement your assigned task step by step
3. When ready to test, write 'UNITY_REQUEST:compile' on its own line
4. Wait for the coordinator to process your request
5. Check the error registry (_AiDevLog/Errors/error_registry.md) for errors assigned to you
6. Fix any assigned errors (update error registry status!)
7. **UPDATE DOCUMENTATION:** Prefer updating existing docs. For new systems add new doc in _AiDevLog/Docs/. Write summary of changes in your log.
8. Mark your checkbox [x] in the plan file, continue to next task or write 'BLOCKED: [reason]' if stuck
   (Note: Context is updated automatically by coordinator's context agent after task completion)

**Testing Guidelines (from best practices):**
- Data/Logic tasks → EditMode tests only
- Scene/UI tasks → PlayMode tests only  
- Gameplay tasks → EditMode + PlayMode + Player test
- Simple data classes → No tests needed
- DON'T over-test! Tests are overhead if they don't catch bugs.

**Important:**
- DO NOT directly focus Unity or exit playmode - use UNITY_REQUEST markers
- ALWAYS check error registry before fixing any error
- DO NOT create .meta files manually"
else
  PROMPT="You are $ENGINEER_NAME, reference the plan at $PLAN_FILE.
You have unityMCP available for reading Unity state (but NOT for controlling it directly).

📚 **REQUIRED: Read Unity Best Practices First**
Before implementing ANY task, you MUST read this file:
\`$BEST_PRACTICES_FILE\`

Use read_file tool to read it NOW. Key sections:
- Section 6: Testing - Don't over-test! Match test type to task type
- Section 7: Prototyping - Placeholders must match final tech stack  
- Section 2: Asset Management - Never create .meta files manually

$UNITY_WORKFLOW

**Your Workflow:**
0. **FIRST:** Read previous session logs from _AiDevLog/Logs/engineers/, read context and existing docs for your task
1. Read the plan and identify your assigned tasks
2. Read the best practices doc for guidance relevant to your task
3. Implement tasks step by step
4. When ready to test, write 'UNITY_REQUEST:compile' on its own line
5. Wait for the coordinator to process your request
6. Check the error registry (_AiDevLog/Errors/error_registry.md) for errors assigned to you
7. Fix any assigned errors (update error registry status!)
8. **UPDATE DOCUMENTATION:** Prefer updating existing docs. For new systems add new doc in _AiDevLog/Docs/. Write summary of changes in your log.
9. Mark your checkbox [x] in the plan file, continue to next task or write 'BLOCKED: [reason]' if stuck
   (Note: Context is updated automatically by coordinator's context agent after task completion)

**Testing Guidelines (from best practices):**
- Data/Logic tasks → EditMode tests only
- Scene/UI tasks → PlayMode tests only  
- Gameplay tasks → EditMode + PlayMode + Player test
- Simple data classes → No tests needed
- DON'T over-test! Tests are overhead if they don't catch bugs.

**Important:**
- DO NOT directly focus Unity or exit playmode - use UNITY_REQUEST markers
- ALWAYS check error registry before fixing any error
- DO NOT create .meta files manually"
fi

# Run cursor agent in background with real-time streaming
(
  cursor agent --model "sonnet-4.5" -p --force \
    --output-format stream-json \
    --stream-partial-output \
    "$PROMPT" 2>&1 | \
    while IFS= read -r line; do
      # Get the message type and extract text
      msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
      
      if [ "$msg_type" = "assistant" ]; then
        # Extract text content from assistant message
        content_type=$(echo "$line" | jq -r '.message.content[0].type // empty' 2>/dev/null)
        content_text=$(echo "$line" | jq -r '.message.content[0].text // empty' 2>/dev/null)
        tool_name=$(echo "$line" | jq -r '.message.content[0].name // empty' 2>/dev/null)
        
        if [ "$content_type" = "thinking" ] && [ -n "$content_text" ] && [ "$content_text" != "null" ]; then
          # Thinking text in cyan (streaming)
          printf "${COLOR_THINKING}%s${COLOR_RESET}" "$content_text"
        elif [ "$content_type" = "text" ] && [ -n "$content_text" ] && [ "$content_text" != "null" ]; then
          # Response text in green (streaming)
          printf "${COLOR_RESPONSE}%s${COLOR_RESET}" "$content_text"
        elif [ "$content_type" = "tool_use" ] && [ -n "$tool_name" ] && [ "$tool_name" != "null" ]; then
          # Tool call in yellow
          printf "\n${COLOR_TOOL}🔧 Tool: %s${COLOR_RESET}\n" "$tool_name"
        fi
      elif [ "$msg_type" = "result" ]; then
        # Final result - add newline
        printf "\n"
      fi
    done | tee -a "$LOG_FILE"
  
  # Record completion
  exit_status=${PIPESTATUS[0]}
  total_time=$(($(date +%s) - START_TIME))
  
  echo "" >> "$LOG_FILE"
  if [ $exit_status -eq 0 ]; then
    echo "[$ENGINEER_NAME] ✅ Session completed successfully in ${total_time}s" >> "$LOG_FILE"
  else
    echo "[$ENGINEER_NAME] ❌ Session ended with error (exit code: $exit_status) after ${total_time}s" >> "$LOG_FILE"
  fi
) &

# Get background job PID
CURSOR_PID=$!

# Background timeout watcher
(
  sleep ${MAX_RUNTIME_SECONDS}
  if kill -0 $CURSOR_PID 2>/dev/null; then
    echo "[$ENGINEER_NAME] ⏰ TIMEOUT: Session exceeded ${MAX_RUNTIME_SECONDS}s" >> "$LOG_FILE"
    kill $CURSOR_PID 2>/dev/null
  fi
) &

echo "Engineer $ENGINEER_NAME started in background (PID: $CURSOR_PID)"
echo "Session ID: $SESSION_ID"
echo "Log file: $LOG_FILE"

if [ "$HEADLESS_MODE" = true ]; then
  # Headless mode: just print info and exit (for coordinator use)
  echo "Running in headless mode - monitor log file for progress"
  echo "HEADLESS_PID=$CURSOR_PID"
  echo "HEADLESS_LOG=$LOG_FILE"
  echo "HEADLESS_SESSION=$SESSION_ID"
else
  # Interactive mode: tail the log file for real-time viewing
  echo "Watching log file in real-time..."
  echo "Press Ctrl+C to stop watching (engineer will keep running)"
  echo ""
  # Output engineer name continuously in background to set terminal title
  ( while true; do printf '\033]0;%s_%s\007' "${ENGINEER_NAME}" "${SESSION_ID}"; sleep 1; done ) &
  TITLE_PID=$!
  trap "kill $TITLE_PID 2>/dev/null" EXIT
  exec tail -f "$LOG_FILE"
fi

