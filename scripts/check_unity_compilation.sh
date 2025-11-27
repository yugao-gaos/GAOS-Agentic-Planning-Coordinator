#!/bin/bash
# Unity Compilation Checker Script
# This script prepares Unity and triggers compilation checking
# Usage: bash check_unity_compilation.sh [wait_seconds]
#
# WHAT THIS SCRIPT DOES:
# 1. Checks Unity Editor is running
# 2. Uses cursor agent to call MCP tools (exit playmode, switch to temp scene)
# 3. Focuses Unity Editor window (triggers file change detection on macOS)
# 4. Waits initial period for compilation to start
#
# AFTER RUNNING THIS SCRIPT:
# From Cursor, poll editor state until compilation complete:
#   fetch_mcp_resource server='user-unityMCP' uri='unity://editor/state'
#   Check isCompiling field until it's false

# Configuration
WAIT_SECONDS=${1:-30}  # Default 30 seconds initial wait time

# Color codes for output
COLOR_INFO='\033[0;36m'     # Cyan
COLOR_SUCCESS='\033[0;32m'  # Green
COLOR_WARNING='\033[0;33m'  # Yellow
COLOR_ERROR='\033[0;31m'    # Red
COLOR_RESET='\033[0m'

echo -e "${COLOR_INFO}========================================${COLOR_RESET}"
echo -e "${COLOR_INFO}Unity Compilation Checker${COLOR_RESET}"
echo -e "${COLOR_INFO}========================================${COLOR_RESET}"
echo ""

# Step 1: Check if Unity Editor is running
echo -e "${COLOR_INFO}[Step 1/4] Checking Unity Editor status...${COLOR_RESET}"
UNITY_PROCESS=$(ps aux | grep -i "Unity" | grep -v "grep" | grep -v "Helper" | grep -v "Hub" | head -1)

if [ -z "$UNITY_PROCESS" ]; then
  echo -e "${COLOR_ERROR}✗ Unity Editor process not found${COLOR_RESET}"
  echo -e "${COLOR_INFO}Please start Unity Editor before running this script${COLOR_RESET}"
  exit 1
else
  echo -e "${COLOR_SUCCESS}✓ Unity Editor is running${COLOR_RESET}"
fi
echo ""

# Step 2: MCP preparation via cursor agent (exit playmode, switch to temp scene)
echo -e "${COLOR_INFO}[Step 2/4] Preparing Unity via cursor agent...${COLOR_RESET}"
echo -e "${COLOR_INFO}   (Using cursor agent to call MCP tools)${COLOR_RESET}"

MCP_PREP_SUCCESS=false

# Check if cursor CLI is available
if command -v cursor &> /dev/null; then
  # Get the project root (current directory)
  PROJECT_ROOT=$(pwd)
  
  # Step 2a: Check and exit playmode if needed
  echo -e "${COLOR_INFO}   Checking playmode status...${COLOR_RESET}"
  PLAYMODE_RESULT=$(cursor agent --print --output-format text --approve-mcps --force --model gpt-5 --workspace "$PROJECT_ROOT" \
    "Check Unity editor state using fetch_mcp_resource with uri='unity://editor/state'. If isPlaying is true, use mcp_unityMCP_manage_editor with action='stop'. Reply only: 'STOPPED' if you stopped playmode, 'NOT_PLAYING' if not in playmode, or 'ERROR: reason' if failed." 2>&1 | tail -1)
  
  if echo "$PLAYMODE_RESULT" | grep -qE "(STOPPED|NOT_PLAYING)"; then
    echo -e "${COLOR_SUCCESS}   ✓ Playmode check: $PLAYMODE_RESULT${COLOR_RESET}"
    if echo "$PLAYMODE_RESULT" | grep -q "STOPPED"; then
      sleep 2  # Give Unity time to exit playmode
    fi
  else
    echo -e "${COLOR_WARNING}   ⚠ Playmode check: $PLAYMODE_RESULT${COLOR_RESET}"
  fi
  
  # Step 2b: Create or load temp scene
  echo -e "${COLOR_INFO}   Switching to temp scene...${COLOR_RESET}"
  SCENE_RESULT=$(cursor agent --print --output-format text --approve-mcps --force --model gpt-5 --workspace "$PROJECT_ROOT" \
    "Use mcp_unityMCP_manage_scene with action='create', name='_TempCompileCheck', path='Assets/Scenes'. If it fails because scene exists, use action='load' instead. Reply only: 'CREATED', 'LOADED', or 'ERROR: reason'." 2>&1 | tail -1)
  
  if echo "$SCENE_RESULT" | grep -qE "(CREATED|LOADED|succeeded|created|loaded)"; then
    echo -e "${COLOR_SUCCESS}   ✓ Scene switch: $SCENE_RESULT${COLOR_RESET}"
    MCP_PREP_SUCCESS=true
  else
    echo -e "${COLOR_WARNING}   ⚠ Scene switch: $SCENE_RESULT${COLOR_RESET}"
  fi
else
  echo -e "${COLOR_WARNING}   ⚠ Cursor CLI not found in PATH${COLOR_RESET}"
fi

if [ "$MCP_PREP_SUCCESS" = false ]; then
  echo -e "${COLOR_WARNING}   ⚠ MCP prep may have failed - scene reload dialogs may appear${COLOR_RESET}"
  echo -e "${COLOR_INFO}   The script will attempt to auto-dismiss any dialogs${COLOR_RESET}"
fi
echo ""

# Step 3: Focus Unity to trigger compilation (scene reload dialog should be avoided by temp scene)
echo -e "${COLOR_INFO}[Step 3/4] Focusing Unity Editor window...${COLOR_RESET}"
echo -e "${COLOR_INFO}   This triggers file change detection and compilation on macOS${COLOR_RESET}"
echo -e "${COLOR_INFO}   (Temp scene should prevent scene reload dialogs; auto-dismiss as fallback)${COLOR_RESET}"

# Find the Unity Editor process that has the project open (not Unity Hub)
UNITY_PID=$(ps aux | grep -i unity | grep "$(basename "$PWD")" | grep -v grep | head -1 | awk '{print $2}')

if [ -z "$UNITY_PID" ]; then
  # Fallback: try to find any Unity Editor process with -projectPath
  UNITY_PID=$(ps aux | grep -i unity | grep "\-projectPath" | grep -v grep | head -1 | awk '{print $2}')
fi

if [ -z "$UNITY_PID" ]; then
  echo -e "${COLOR_WARNING}⚠ Could not identify Unity Editor process ID${COLOR_RESET}"
  echo -e "${COLOR_INFO}   Trying generic Unity activation...${COLOR_RESET}"
  osascript -e 'tell application "Unity" to activate' 2>/dev/null
  sleep 1
else
  echo -e "${COLOR_INFO}   Found Unity Editor: PID ${UNITY_PID}${COLOR_RESET}"
  osascript -e "tell application \"System Events\"" \
            -e "set frontmost of first process whose unix id is ${UNITY_PID} to true" \
            -e "end tell" 2>/dev/null
  sleep 1
fi

# Verify if Unity is actually frontmost
FRONTMOST_APP=$(osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true' 2>/dev/null)

if [ "$FRONTMOST_APP" = "Unity" ]; then
  echo -e "${COLOR_SUCCESS}✓ Unity Editor window focused successfully${COLOR_RESET}"
  
  # Auto-dismiss scene reload dialog if present (press Tab to select Reload, then Enter)
  echo -e "${COLOR_INFO}   Attempting to auto-dismiss any scene reload dialogs...${COLOR_RESET}"
  sleep 1
  osascript -e 'tell application "System Events" to keystroke tab using {shift down}' 2>/dev/null  # Tab to Reload button
  sleep 0.5
  osascript -e 'tell application "System Events" to keystroke return' 2>/dev/null  # Press Enter
  sleep 1
  echo -e "${COLOR_INFO}   (If no dialog was present, this has no effect)${COLOR_RESET}"
  
elif [ -z "$FRONTMOST_APP" ]; then
  echo -e "${COLOR_WARNING}⚠ Unable to verify window focus (System Events not accessible)${COLOR_RESET}"
  echo -e "${COLOR_INFO}   Please manually click on Unity Editor window now...${COLOR_RESET}"
  sleep 3
else
  echo -e "${COLOR_WARNING}⚠ Could not automatically focus Unity Editor${COLOR_RESET}"
  echo -e "${COLOR_INFO}   Current foreground app: ${FRONTMOST_APP}${COLOR_RESET}"
  echo -e "${COLOR_INFO}   ${COLOR_WARNING}ACTION REQUIRED: Please click on Unity Editor window now!${COLOR_RESET}"
  echo -e "${COLOR_INFO}   Waiting 5 seconds for manual focus...${COLOR_RESET}"
  sleep 5
  
  # Check again
  FRONTMOST_APP=$(osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true' 2>/dev/null)
  if [ "$FRONTMOST_APP" = "Unity" ]; then
    echo -e "${COLOR_SUCCESS}✓ Unity Editor window is now focused${COLOR_RESET}"
    
    # Auto-dismiss scene reload dialog if present
    echo -e "${COLOR_INFO}   Attempting to auto-dismiss any scene reload dialogs...${COLOR_RESET}"
    sleep 1
    osascript -e 'tell application "System Events" to keystroke tab using {shift down}' 2>/dev/null
    sleep 0.5
    osascript -e 'tell application "System Events" to keystroke return' 2>/dev/null
    sleep 1
  else
    echo -e "${COLOR_WARNING}⚠ Unity Editor still not focused. Continuing anyway...${COLOR_RESET}"
  fi
fi
echo ""

# Step 4: Wait for Unity to detect changes and start compilation
echo -e "${COLOR_INFO}[Step 4/4] Waiting for Unity to detect changes...${COLOR_RESET}"
echo -e "${COLOR_INFO}   Initial wait: ${WAIT_SECONDS} seconds${COLOR_RESET}"

# Show countdown
for (( i=$WAIT_SECONDS; i>0; i-- )); do
  if [ $i -eq $WAIT_SECONDS ] || [ $i -eq 20 ] || [ $i -eq 10 ] || [ $i -eq 5 ] || [ $i -eq 1 ]; then
    echo -e "${COLOR_INFO}   ${i}s remaining...${COLOR_RESET}"
  fi
  sleep 1
done

echo -e "${COLOR_SUCCESS}✓ Initial wait period completed (${WAIT_SECONDS}s)${COLOR_RESET}"
echo ""

# Final: Focus back to Cursor for MCP polling
echo -e "${COLOR_INFO}Switching focus back to Cursor...${COLOR_RESET}"
echo -e "${COLOR_INFO}   Ready to poll compilation status via MCP${COLOR_RESET}"

# Try to activate Cursor
osascript -e 'tell application "Cursor" to activate' 2>/dev/null
if [ $? -eq 0 ]; then
  sleep 1
  FRONTMOST_APP=$(osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true' 2>/dev/null)
  if [ "$FRONTMOST_APP" = "Cursor" ]; then
    echo -e "${COLOR_SUCCESS}✓ Cursor window focused successfully${COLOR_RESET}"
  else
    echo -e "${COLOR_WARNING}⚠ Cursor activated but may not be frontmost${COLOR_RESET}"
  fi
else
  echo -e "${COLOR_WARNING}⚠ Could not activate Cursor automatically${COLOR_RESET}"
  echo -e "${COLOR_INFO}   Please manually switch to Cursor to continue...${COLOR_RESET}"
fi
echo ""

# Summary
echo -e "${COLOR_INFO}========================================${COLOR_RESET}"
echo -e "${COLOR_INFO}Unity Compilation Check - Ready${COLOR_RESET}"
echo -e "${COLOR_INFO}========================================${COLOR_RESET}"
echo ""
echo -e "${COLOR_SUCCESS}✓ Unity Editor is running and focused${COLOR_RESET}"
echo -e "${COLOR_SUCCESS}✓ Initial wait completed (${WAIT_SECONDS}s)${COLOR_RESET}"
echo ""
echo -e "${COLOR_INFO}${COLOR_WARNING}CRITICAL: Poll Compilation Status Until Complete${COLOR_RESET}"
echo ""
echo -e "${COLOR_INFO}Required Actions (from Cursor with MCP):${COLOR_RESET}"
echo ""
echo -e "  ${COLOR_WARNING}Step 1: Check editor state${COLOR_RESET}"
echo -e "  fetch_mcp_resource server='user-unityMCP' uri='unity://editor/state'"
echo ""
echo -e "  ${COLOR_WARNING}Step 2: Check the response${COLOR_RESET}"
echo -e "  Look for: ${COLOR_INFO}\"isCompiling\": true/false${COLOR_RESET}"
echo ""
echo -e "  ${COLOR_WARNING}Step 3: If isCompiling=true (still compiling):${COLOR_RESET}"
echo -e "  - Wait 10-15 seconds: ${COLOR_INFO}sleep 15${COLOR_RESET}"
echo -e "  - Check editor state again (repeat Step 1)"
echo -e "  - Continue until isCompiling=false"
echo ""
echo -e "  ${COLOR_WARNING}Step 4: Once isCompiling=false (compilation complete):${COLOR_RESET}"
echo -e "  - Check for errors/warnings:"
echo -e "    ${COLOR_INFO}mcp_unityMCP_read_console action='get' count=50 types=['error','warning']${COLOR_RESET}"
echo ""
echo -e "  ${COLOR_WARNING}Step 5: Handle results:${COLOR_RESET}"
echo -e "  - ${COLOR_SUCCESS}0 errors:${COLOR_RESET} Continue to next task"
echo -e "  - ${COLOR_ERROR}N errors:${COLOR_RESET} Dispatch parallel engineers to fix"
echo ""
echo -e "${COLOR_INFO}========================================${COLOR_RESET}"

exit 0
