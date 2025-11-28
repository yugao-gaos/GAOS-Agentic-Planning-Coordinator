#!/bin/bash
# Engineer session for macOS with background execution and log file
# Usage: bash run_engineer.sh [--headless] <engineer_name> <plan_file_path> [additional_instruction] [max_runtime_seconds]
#
# Options:
#   --headless    Run without tailing log (for coordinator/automation use)
#
# ⚠️ IMPORTANT: DO NOT create new shell scripts for workflow control!
# The existing scripts in _AiDevLog/Scripts/ are sufficient:
#   - run_engineer.sh (this file) - Run engineer sessions
#   - check_unity_compilation.sh - Check Unity compilation
#   - play_mode_test.sh - Test in Play Mode
#   - understand_unity_context.sh - Analyze Unity project
# Engineers should use these scripts and Unity MCP tools, NOT create new automation scripts.

# Check for --headless flag
HEADLESS_MODE=false
if [ "$1" = "--headless" ]; then
  HEADLESS_MODE=true
  shift  # Remove --headless from arguments
fi

# Validate arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 [--headless] <engineer_name> <plan_file_path> [additional_instruction] [max_runtime_seconds]"
  echo ""
  echo "Options:"
  echo "  --headless    Run without tailing log (for coordinator/automation use)"
  echo ""
  echo "Examples:"
  echo "  $0 \"Alex\" \"_AiDevLog/Plans/Match3ImplementationPlan.md\""
  echo "  $0 \"Alex\" \"_AiDevLog/Plans/Match3ImplementationPlan.md\" \"Fix the gem spawning bug\""
  echo "  $0 \"Alex\" \"_AiDevLog/Plans/Match3ImplementationPlan.md\" \"Fix the gem spawning bug\" 7200"
  echo "  $0 --headless \"Alex\" \"_AiDevLog/Plans/Plan.md\" \"Task\" 3600  # For coordinator"
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
LOG_DIR="_AiDevLog/Logs"

# Find next available session number (incremental)
SESSION_NUM=0
while [ -f "${LOG_DIR}/engineer_${ENGINEER_NAME}_session_$(printf "%04d" $SESSION_NUM).log" ]; do
  SESSION_NUM=$((SESSION_NUM + 1))
done

SESSION_ID=$(printf "%04d" $SESSION_NUM)
LOG_FILE="${LOG_DIR}/engineer_${ENGINEER_NAME}_session_${SESSION_ID}.log"

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

### Unity Editor Testing & Debugging Workflow:

**CRITICAL: Unity Recompilation Requirements**
- Unity ONLY recompiles scripts when:
  1. NOT in playmode
  2. Editor window is focused (or forced via script)
- After modifying C# scripts, you MUST:
  1. Exit playmode: use 'stop_game' MCP tool
  2. Force recompilation: use 'execute_script' with CompilationPipeline.RequestScriptCompilation() OR use terminal command 'osascript -e \"tell application \\\"Unity\\\" to activate\"'
  3. Wait 2-3 seconds for Unity to detect changes
  4. Check compilation: use 'check_compile_errors' MCP tool
  5. Only then can you test in playmode

**CRITICAL: Unity .meta Files**
- **NEVER create .meta files manually**
- **NEVER write .meta files using any tools**
- Unity automatically generates .meta files for all assets
- If you create/modify assets, let Unity handle the .meta file generation
- Creating .meta files manually can cause GUID conflicts and asset corruption

**Testing Workflow After Implementation:**
1. Check editor status: 'get_unity_editor_state'
2. Ensure compilation: 'check_compile_errors'
3. Enter playmode for runtime testing: 'play_game'
4. Check runtime errors: 'get_unity_logs' (filter by errors/warnings)
5. Visual validation: 'get_scene_view_screenshot' or 'capture_ui_canvas'
6. Exit playmode: 'stop_game'
7. Fix any issues found and repeat

**IMPORTANT: Only ONE engineer can control Unity Editor at a time**
- If you need to test in playmode, coordinate with other engineers
- Other engineers should work on non-editor tasks during your testing
- Always exit playmode ('stop_game') when done testing so others can work

**Session Context:**
- This is session $SESSION_ID for engineer $ENGINEER_NAME
- Previous session logs are available in ${LOG_DIR}/ - read them to understand past work and avoid repeating mistakes
- Check previous logs if you encounter issues that might have been solved before
"

# Build the prompt based on whether additional instruction is provided
if [ -n "$ADDITIONAL_INSTRUCTION" ]; then
  PROMPT="You are $ENGINEER_NAME. 

🎯 PRIMARY FOCUS: $ADDITIONAL_INSTRUCTION

Please prioritize the above instruction while referencing the overall plan at $PLAN_FILE for context. You have unityMCP available to you if you need unity tool operations. 
$UNITY_WORKFLOW

Think step by step and implement your tasks. If you need unity to compile, make sure to call mcp tool to exit from playmode and force recompilation.
Each time you finished a task, call OpenAI Codex cli to review your changes and fix accordingly. Call mcp tool to review unity console and fix if there is error. After review and fix, if a task is finished, mark your check list in the plan file, and continue to next task, do not stop until you reach a blocker and need to wait for teammate. 

Once you stop, write a summary of everything that is done and report to me, do not create straight md files for report. However if you made new systems, you need to create documentation for it in docs folder $DOCS_FOLDER, and update future tasks in $PLAN_FILE to reference new doc. If you have update existing system, you need to update existing documentation."
else
  PROMPT="You are $ENGINEER_NAME, please reference the plan $PLAN_FILE, you have unityMCP available to you if you need unity tool operations. 
$UNITY_WORKFLOW

Think step by step and implement your tasks. Each time you finished a task, call OpenAI Codex cli to review your changes and fix accordingly. Call mcp tool to review unity console and fix if there is error. After review and fix, if a task is finished, mark your check list in the plan file, and continue to next task, do not stop until you reach a blocker and need to wait for teammate. Once you stop, write a summary of everything that is done and report to me, do not create straight md files for report. However if you made new systems, you need to create documentation for it in docs folder $DOCS_FOLDER, and update future tasks in $PLAN_FILE to reference new doc. If you have update existing system, you need to update existing documentation."
fi

# Run cursor agent in background with real-time streaming
(
  cursor agent --model "sonnet-4.5" -p --force \
    --output-format stream-json \
    --stream-partial-output \
    "$PROMPT" 2>&1 | \
    while IFS= read -r line; do
      # Extract content type and text
      content_type=$(echo "$line" | jq -r '.message.content[0].type // empty' 2>/dev/null)
      content_text=$(echo "$line" | jq -r '.message.content[0].text // empty' 2>/dev/null)
      tool_name=$(echo "$line" | jq -r '.message.content[0].name // empty' 2>/dev/null)
      
      # Handle different content types with colors
      if [ "$content_type" = "thinking" ] && [ -n "$content_text" ] && [ "$content_text" != "null" ] && [ "$content_text" != "empty" ]; then
        # Thinking text in cyan
        printf "${COLOR_THINKING}%s${COLOR_RESET}" "$content_text" | sed 's/\. /.\n/g'
      elif [ "$content_type" = "text" ] && [ -n "$content_text" ] && [ "$content_text" != "null" ] && [ "$content_text" != "empty" ]; then
        # Response text in green
        printf "${COLOR_RESPONSE}%s${COLOR_RESET}" "$content_text" | sed 's/\. /.\n/g'
      elif [ -n "$tool_name" ] && [ "$tool_name" != "null" ] && [ "$tool_name" != "empty" ]; then
        # Tool call in yellow
        printf "\n${COLOR_TOOL}🔧 Tool: %s${COLOR_RESET}\n" "$tool_name"
      elif [ -n "$content_text" ] && [ "$content_text" != "null" ] && [ "$content_text" != "empty" ]; then
        # Fallback for other text
        printf "%s" "$content_text" | sed 's/\. /.\n/g'
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

