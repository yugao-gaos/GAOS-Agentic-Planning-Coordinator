#!/usr/bin/env python3
"""
Agentic Planning Coordinator Script
===================================
Implements the workflow from agentic-planning.mdc

This script acts as the Coordinator, managing multiple AI engineers to execute a plan.
It runs autonomously and:
- Launches engineers as background subprocesses using run_engineer.sh --headless
- Monitors progress via log files
- Handles Unity compilation checks
- Reports progress to the user

Usage:
    python3 coordinator.py <plan_file_path>
    python3 coordinator.py _AiDevLog/Plans/Match3_ImplementationPlan.md
    python3 coordinator.py _AiDevLog/Plans/Plan.md --mode auto --yes

Requirements:
    - cursor CLI installed and in PATH
    - Unity Editor running (for Unity projects)
"""

import os
import sys
import re
import time
import json
import subprocess
import argparse
import platform
import shutil
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
from enum import Enum

# =============================================================================
# Configuration
# =============================================================================

ENGINEERS = ["Alex", "Betty", "Cleo", "Dany", "Eddy"]
DEFAULT_TIMEOUT = 3600  # 1 hour
WAIT_INTERVAL = 60  # 1 minute between checks (can be overridden via --wait)
LOG_DIR = "_AiDevLog/Logs"
SCRIPTS_DIR = "_AiDevLog/Scripts"

# ANSI Colors
class Colors:
    CYAN = '\033[0;36m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[0;33m'
    RED = '\033[0;31m'
    BLUE = '\033[0;34m'
    MAGENTA = '\033[0;35m'
    BOLD = '\033[1m'
    RESET = '\033[0m'

# =============================================================================
# Data Classes
# =============================================================================

class ExecutionMode(Enum):
    AUTO_CONTINUE = "auto"
    INTERACTIVE = "interactive"

class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"

class EngineerStatus(Enum):
    IDLE = "idle"
    WORKING = "working"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    ERROR = "error"

@dataclass
class Task:
    """Represents a task from the plan"""
    id: str
    description: str
    engineer: Optional[str] = None
    status: TaskStatus = TaskStatus.PENDING
    dependencies: List[str] = field(default_factory=list)
    
@dataclass
class EngineerSession:
    """Tracks an engineer's session"""
    name: str
    session_id: str
    log_file: str
    task_instruction: str
    start_time: datetime
    status: EngineerStatus = EngineerStatus.WORKING
    pid: Optional[int] = None

# =============================================================================
# Utility Functions
# =============================================================================

def print_header(text: str):
    """Print a formatted header"""
    print(f"\n{Colors.CYAN}{'='*60}{Colors.RESET}")
    print(f"{Colors.CYAN}{Colors.BOLD}{text}{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*60}{Colors.RESET}\n")

def print_info(text: str):
    """Print info message"""
    print(f"{Colors.CYAN}ℹ {text}{Colors.RESET}")

def print_success(text: str):
    """Print success message"""
    print(f"{Colors.GREEN}✓ {text}{Colors.RESET}")

def print_warning(text: str):
    """Print warning message"""
    print(f"{Colors.YELLOW}⚠ {text}{Colors.RESET}")

def print_error(text: str):
    """Print error message"""
    print(f"{Colors.RED}✗ {text}{Colors.RESET}")

def print_step(step_num: int, total: int, text: str):
    """Print step indicator"""
    print(f"\n{Colors.BLUE}[Step {step_num}/{total}]{Colors.RESET} {Colors.BOLD}{text}{Colors.RESET}")

def get_project_root() -> Path:
    """Get the project root directory"""
    # Look for common Unity project indicators
    current = Path.cwd()
    while current != current.parent:
        if (current / "Assets").exists() or (current / "_AiDevLog").exists():
            return current
        current = current.parent
    return Path.cwd()

def get_next_session_id(engineer_name: str, log_dir: Path) -> str:
    """Get the next available session ID for an engineer"""
    session_num = 0
    while (log_dir / f"engineer_{engineer_name}_session_{session_num:04d}.log").exists():
        session_num += 1
    return f"{session_num:04d}"

# =============================================================================
# Plan Parsing
# =============================================================================

def parse_plan_file(plan_path: Path) -> Dict:
    """Parse a plan markdown file to extract tasks and engineer assignments"""
    if not plan_path.exists():
        raise FileNotFoundError(f"Plan file not found: {plan_path}")
    
    content = plan_path.read_text()
    
    plan_data = {
        "title": "",
        "description": "",
        "engineers_needed": [],
        "engineer_checklists": {},
        "tasks": []
    }
    
    # Extract title (first # heading)
    title_match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
    if title_match:
        plan_data["title"] = title_match.group(1).strip()
    
    # Extract engineers needed
    engineers_match = re.search(r'(?:engineers?\s+needed|how\s+many\s+engineers)[:\s]+(.+?)(?:\n|$)', 
                                 content, re.IGNORECASE)
    if engineers_match:
        engineers_str = engineers_match.group(1)
        for eng in ENGINEERS:
            if eng.lower() in engineers_str.lower():
                plan_data["engineers_needed"].append(eng)
    
    # Extract engineer checklists
    # Pattern: #Engineer's checklist or ##Engineer checklist
    checklist_pattern = r'##+\s*(\w+)[\'\']?s?\s+checklist\s*([\s\S]*?)(?=(?:##+\s*\w+[\'\']?s?\s+checklist)|$)'
    
    for match in re.finditer(checklist_pattern, content, re.IGNORECASE):
        engineer_name = match.group(1).strip()
        checklist_content = match.group(2).strip()
        
        # Normalize engineer name
        for eng in ENGINEERS:
            if eng.lower() == engineer_name.lower():
                engineer_name = eng
                break
        
        tasks = []
        # Parse checklist items: - [ ] or - [x] or N. [ ] or N. [x]
        task_pattern = r'(?:^|\n)\s*(?:\d+\.|\-|\*)\s*\[([ xX])\]\s*(.+?)(?=\n|$)'
        for task_match in re.finditer(task_pattern, checklist_content):
            is_complete = task_match.group(1).lower() == 'x'
            task_desc = task_match.group(2).strip()
            tasks.append({
                "description": task_desc,
                "completed": is_complete,
                "status": TaskStatus.COMPLETED if is_complete else TaskStatus.PENDING
            })
        
        plan_data["engineer_checklists"][engineer_name] = tasks
        
        # Add to engineers_needed if not already there
        if engineer_name in ENGINEERS and engineer_name not in plan_data["engineers_needed"]:
            plan_data["engineers_needed"].append(engineer_name)
    
    return plan_data

def get_plan_progress(plan_data: Dict) -> Tuple[int, int, float]:
    """Calculate plan progress: (completed, total, percentage)"""
    total = 0
    completed = 0
    
    for engineer, tasks in plan_data["engineer_checklists"].items():
        for task in tasks:
            total += 1
            if task.get("completed", False):
                completed += 1
    
    percentage = (completed / total * 100) if total > 0 else 0
    return completed, total, percentage

def get_uncompleted_tasks(plan_data: Dict) -> Dict[str, List[Dict]]:
    """Get uncompleted tasks grouped by engineer"""
    uncompleted = {}
    
    for engineer, tasks in plan_data["engineer_checklists"].items():
        engineer_tasks = []
        for task in tasks:
            if not task.get("completed", False):
                engineer_tasks.append(task)
        if engineer_tasks:
            uncompleted[engineer] = engineer_tasks
    
    return uncompleted

# =============================================================================
# Engineer Management
# =============================================================================

def open_cursor_integrated_terminal(command: str, title: str, working_dir: str) -> bool:
    """
    Open a new Cursor integrated terminal with the given command.
    Uses keyboard automation to interact with Cursor's Command Palette.
    Cross-platform: macOS, Linux, Windows
    Returns True if successful.
    """
    system = platform.system()
    
    try:
        if system == "Darwin":  # macOS
            # Use AppleScript to:
            # 1. Focus Cursor
            # 2. Open Command Palette (Cmd+Shift+P)
            # 3. Create new terminal
            # 4. Rename terminal
            # 5. cd to working dir and run command
            
            # Escape special characters for AppleScript
            escaped_command = command.replace('\\', '\\\\').replace('"', '\\"')
            escaped_title = title.replace('"', '\\"')
            escaped_dir = working_dir.replace('"', '\\"')
            
            applescript = f'''
            tell application "Cursor"
                activate
            end tell
            delay 0.5
            
            tell application "System Events"
                -- Open Command Palette (Cmd+Shift+P)
                keystroke "p" using {{command down, shift down}}
                delay 0.5
                
                -- Type command to create new terminal
                keystroke "Terminal: Create New Terminal"
                delay 0.3
                keystroke return
                delay 1.5
                
                -- Rename the terminal via Command Palette
                keystroke "p" using {{command down, shift down}}
                delay 0.4
                keystroke "Terminal: Rename"
                delay 0.3
                keystroke return
                delay 0.4
                keystroke "{escaped_title}"
                delay 0.2
                keystroke return
                delay 0.5
                
                -- cd to working directory and run command
                keystroke "cd \\"{escaped_dir}\\" && {escaped_command}"
                delay 0.2
                keystroke return
            end tell
            '''
            
            result = subprocess.run(
                ['osascript', '-e', applescript],
                capture_output=True, text=True
            )
            if result.returncode != 0:
                print_warning(f"AppleScript warning: {result.stderr}")
            return True
            
        elif system == "Windows":
            # Use PowerShell to send keystrokes to Cursor
            # Escape for PowerShell string
            escaped_command = command.replace('"', '`"').replace("'", "''")
            escaped_title = title.replace('"', '`"')
            escaped_dir = working_dir.replace('\\', '\\\\')
            
            powershell_script = f'''
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName Microsoft.VisualBasic
            
            $cursor = Get-Process -Name "Cursor" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cursor) {{
                [Microsoft.VisualBasic.Interaction]::AppActivate($cursor.Id)
                Start-Sleep -Milliseconds 500
                
                # Open Command Palette (Ctrl+Shift+P)
                [System.Windows.Forms.SendKeys]::SendWait("^+p")
                Start-Sleep -Milliseconds 500
                
                # Type command to create new terminal
                [System.Windows.Forms.SendKeys]::SendWait("Terminal: Create New Terminal")
                Start-Sleep -Milliseconds 300
                [System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
                Start-Sleep -Milliseconds 1500
                
                # Rename terminal via Command Palette
                [System.Windows.Forms.SendKeys]::SendWait("^+p")
                Start-Sleep -Milliseconds 400
                [System.Windows.Forms.SendKeys]::SendWait("Terminal: Rename")
                Start-Sleep -Milliseconds 300
                [System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
                Start-Sleep -Milliseconds 400
                [System.Windows.Forms.SendKeys]::SendWait("{escaped_title}")
                Start-Sleep -Milliseconds 200
                [System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
                Start-Sleep -Milliseconds 500
                
                # cd and run command
                [System.Windows.Forms.SendKeys]::SendWait("cd `"{escaped_dir}`" && {escaped_command}")
                Start-Sleep -Milliseconds 200
                [System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
            }}
            '''
            
            result = subprocess.run(
                ['powershell', '-Command', powershell_script],
                capture_output=True, text=True
            )
            if result.returncode != 0:
                print_warning(f"PowerShell warning: {result.stderr}")
            return True
            
        elif system == "Linux":
            # Use xdotool for keystroke simulation on Linux
            if not shutil.which('xdotool'):
                print_error("xdotool not found. Install with: sudo apt install xdotool")
                return False
            
            # Focus Cursor window
            subprocess.run(['xdotool', 'search', '--name', 'Cursor', 'windowactivate'], capture_output=True)
            time.sleep(0.5)
            
            # Open Command Palette (Ctrl+Shift+P)
            subprocess.run(['xdotool', 'key', 'ctrl+shift+p'], capture_output=True)
            time.sleep(0.5)
            
            # Type and execute "Terminal: Create New Terminal"
            subprocess.run(['xdotool', 'type', 'Terminal: Create New Terminal'], capture_output=True)
            time.sleep(0.3)
            subprocess.run(['xdotool', 'key', 'Return'], capture_output=True)
            time.sleep(1.5)
            
            # Rename terminal via Command Palette
            subprocess.run(['xdotool', 'key', 'ctrl+shift+p'], capture_output=True)
            time.sleep(0.4)
            subprocess.run(['xdotool', 'type', 'Terminal: Rename'], capture_output=True)
            time.sleep(0.3)
            subprocess.run(['xdotool', 'key', 'Return'], capture_output=True)
            time.sleep(0.4)
            subprocess.run(['xdotool', 'type', title], capture_output=True)
            time.sleep(0.2)
            subprocess.run(['xdotool', 'key', 'Return'], capture_output=True)
            time.sleep(0.5)
            
            # cd and run command
            full_cmd = f"cd \"{working_dir}\" && {command}"
            subprocess.run(['xdotool', 'type', '--clearmodifiers', full_cmd], capture_output=True)
            time.sleep(0.2)
            subprocess.run(['xdotool', 'key', 'Return'], capture_output=True)
            return True
            
        else:
            print_error(f"Unsupported platform: {system}")
            return False
            
    except Exception as e:
        print_error(f"Failed to open Cursor terminal: {e}")
        import traceback
        traceback.print_exc()
        return False


def launch_engineer_in_terminal(
    engineer_name: str,
    plan_path: str,
    project_root: Path,
    instruction: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT
) -> Optional[EngineerSession]:
    """Launch an engineer session in a new Cursor integrated terminal"""
    
    log_dir = project_root / LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)
    
    session_id = get_next_session_id(engineer_name, log_dir)
    log_file = log_dir / f"engineer_{engineer_name}_session_{session_id}.log"
    
    # Build the command (without --headless since we want to see output in terminal)
    script_path = project_root / SCRIPTS_DIR / "run_engineer.sh"
    
    # Build command string
    if instruction:
        # Escape quotes in instruction for shell
        escaped_instruction = instruction.replace('"', '\\"').replace("'", "'\\''")
        cmd = f'bash "{script_path}" "{engineer_name}" "{plan_path}" "{escaped_instruction}" {timeout}'
    else:
        cmd = f'bash "{script_path}" "{engineer_name}" "{plan_path}" {timeout}'
    
    # Terminal title format: [EngineerName]_[SessionId]
    terminal_title = f"{engineer_name}_{session_id}"
    
    # Open Cursor integrated terminal with the command
    success = open_cursor_integrated_terminal(
        command=cmd,
        title=terminal_title,
        working_dir=str(project_root)
    )
    
    if success:
        print_success(f"Launched {engineer_name} in Cursor terminal (Session: {session_id})")
        print(f"   {Colors.CYAN}Terminal: {terminal_title}{Colors.RESET}")
        print(f"   {Colors.CYAN}Log file: {log_file}{Colors.RESET}")
        
        return EngineerSession(
            name=engineer_name,
            session_id=session_id,
            log_file=str(log_file),
            task_instruction=instruction or "Following plan",
            start_time=datetime.now(),
            pid=None  # PID tracked via log file
        )
    else:
        print_error(f"Failed to launch {engineer_name}")
        return None

def check_engineer_session_status(session: EngineerSession) -> EngineerStatus:
    """Check the status of an engineer session by reading its log file and checking process"""
    log_path = Path(session.log_file)
    
    if not log_path.exists():
        # Check if process is still running by PID
        if session.pid:
            try:
                os.kill(session.pid, 0)  # Signal 0 just checks if process exists
                return EngineerStatus.WORKING
            except OSError:
                pass  # Process doesn't exist
        return EngineerStatus.WORKING  # Log might not be created yet
    
    try:
        content = log_path.read_text()
        
        # Check for completion indicators in log
        if "✅ Session completed successfully" in content:
            return EngineerStatus.COMPLETED
        elif "❌ Session ended with error" in content:
            return EngineerStatus.ERROR
        elif "⏰ TIMEOUT" in content:
            return EngineerStatus.ERROR
        
        # Check recent lines for blocking indicators
        lines = content.split('\n')[-30:]
        recent_text = '\n'.join(lines).lower()
        if "blocked" in recent_text or "waiting for" in recent_text or "cannot proceed" in recent_text:
            return EngineerStatus.BLOCKED
        
        # Check if cursor agent process is still running
        process_running = False
        
        # First check by PID if we have it
        if session.pid:
            try:
                os.kill(session.pid, 0)
                process_running = True
            except OSError:
                pass
        
        # Also check by process name pattern
        if not process_running:
            try:
                result = subprocess.run(
                    ['pgrep', '-f', f'cursor.*agent.*{session.name}'],
                    capture_output=True, text=True
                )
                if result.returncode == 0 and result.stdout.strip():
                    process_running = True
            except:
                pass
        
        if process_running:
            return EngineerStatus.WORKING
        else:
            # Process not running and no completion message - check log size
            if len(content) > 500:  # Has substantial content
                # Likely completed but didn't write completion message
                return EngineerStatus.COMPLETED
            return EngineerStatus.ERROR  # Process died early
            
    except Exception as e:
        print_warning(f"Could not read log for {session.name}: {e}")
        return EngineerStatus.WORKING

def get_active_engineers(sessions: List[EngineerSession]) -> List[EngineerSession]:
    """Get list of engineers that are still working"""
    active = []
    for session in sessions:
        status = check_engineer_session_status(session)
        session.status = status
        if status == EngineerStatus.WORKING:
            active.append(session)
    return active

# =============================================================================
# Unity Compilation
# =============================================================================

def run_unity_compilation_check(project_root: Path, wait_seconds: int = 30) -> bool:
    """Run Unity compilation check script"""
    script_path = project_root / SCRIPTS_DIR / "check_unity_compilation.sh"
    
    if not script_path.exists():
        print_warning("Unity compilation check script not found")
        return False
    
    print_info(f"Running Unity compilation check (wait: {wait_seconds}s)...")
    
    try:
        # Run the compilation check script
        result = subprocess.run(
            ['bash', str(script_path), str(wait_seconds)],
            cwd=str(project_root),
            capture_output=False  # Let output show in terminal
        )
        return result.returncode == 0
    except Exception as e:
        print_error(f"Compilation check failed: {e}")
        return False

def poll_unity_compilation_status() -> Optional[bool]:
    """Poll Unity editor state to check if compilation is complete"""
    print_info("Polling Unity compilation status via MCP...")
    
    try:
        # Use cursor agent to check editor state
        result = subprocess.run(
            ['cursor', 'agent', '--print', '--output-format', 'text', 
             '--approve-mcps', '--force', '--model', 'gpt-5',
             "Use fetch_mcp_resource with uri='unity://editor/state'. "
             "Reply ONLY with: 'COMPILING' if isCompiling is true, "
             "'DONE' if isCompiling is false, or 'ERROR' if failed."],
            capture_output=True, text=True, timeout=60
        )
        
        output = result.stdout.strip().split('\n')[-1]  # Get last line
        
        if 'COMPILING' in output.upper():
            return False  # Still compiling
        elif 'DONE' in output.upper():
            return True  # Compilation complete
        else:
            print_warning(f"Unexpected response: {output}")
            return None
    except subprocess.TimeoutExpired:
        print_warning("MCP polling timed out")
        return None
    except Exception as e:
        print_error(f"Failed to poll compilation status: {e}")
        return None

def check_unity_console_errors() -> Tuple[int, int, List[str]]:
    """Check Unity console for errors and warnings"""
    print_info("Checking Unity console for errors...")
    
    try:
        result = subprocess.run(
            ['cursor', 'agent', '--print', '--output-format', 'text',
             '--approve-mcps', '--force', '--model', 'gpt-5',
             "Use mcp_unityMCP_read_console with action='get', count='50', types=['error','warning']. "
             "Reply with a summary: 'ERRORS: N, WARNINGS: M' followed by a brief list of error messages if any."],
            capture_output=True, text=True, timeout=60
        )
        
        output = result.stdout.strip()
        
        # Parse the response
        errors = 0
        warnings = 0
        messages = []
        
        # Try to extract counts
        error_match = re.search(r'ERRORS?:\s*(\d+)', output, re.IGNORECASE)
        warning_match = re.search(r'WARNINGS?:\s*(\d+)', output, re.IGNORECASE)
        
        if error_match:
            errors = int(error_match.group(1))
        if warning_match:
            warnings = int(warning_match.group(1))
        
        # Extract message lines
        for line in output.split('\n'):
            if 'error' in line.lower() or 'CS0' in line:
                messages.append(line.strip())
        
        return errors, warnings, messages
        
    except Exception as e:
        print_error(f"Failed to check console: {e}")
        return -1, -1, []

# =============================================================================
# User Interface
# =============================================================================

def ask_execution_mode() -> ExecutionMode:
    """Ask user for execution mode selection"""
    print_header("🎯 Execution Mode Selection")
    
    print(f"""I can run in two modes:

{Colors.GREEN}1. AUTO-CONTINUE MODE (Recommended):{Colors.RESET}
   - Coordinator works continuously until all plan tasks complete
   - Reports progress after each wave of engineers
   - Only stops when the entire plan is finished
   - Fastest completion time

{Colors.YELLOW}2. INTERACTIVE MODE:{Colors.RESET}
   - Coordinator reports after each wave of engineers
   - Waits for your approval before continuing
   - You control the pace and can intervene at any checkpoint
""")
    
    while True:
        choice = input(f"\n{Colors.CYAN}Which mode would you prefer? [auto/interactive]: {Colors.RESET}").strip().lower()
        
        if choice in ['auto', 'a', '1', 'continue', 'auto-continue']:
            print_success("Selected: AUTO-CONTINUE mode")
            return ExecutionMode.AUTO_CONTINUE
        elif choice in ['interactive', 'i', '2', 'manual']:
            print_success("Selected: INTERACTIVE mode")
            return ExecutionMode.INTERACTIVE
        else:
            print_warning("Please enter 'auto' or 'interactive'")

def ask_continue() -> bool:
    """Ask user if they want to continue (for interactive mode)"""
    while True:
        choice = input(f"\n{Colors.CYAN}Ready to continue with remaining tasks? [yes/no]: {Colors.RESET}").strip().lower()
        if choice in ['yes', 'y', 'continue', 'c']:
            return True
        elif choice in ['no', 'n', 'stop', 's']:
            return False
        else:
            print_warning("Please enter 'yes' or 'no'")

def print_progress_report(wave: int, plan_data: Dict, sessions: List[EngineerSession], mode: ExecutionMode):
    """Print progress report"""
    completed, total, percentage = get_plan_progress(plan_data)
    
    print_header(f"📊 PROGRESS REPORT - Wave {wave}")
    
    # Completed this wave
    print(f"{Colors.GREEN}✅ Engineer Status This Wave:{Colors.RESET}")
    for session in sessions:
        status_icon = {
            EngineerStatus.COMPLETED: "✅",
            EngineerStatus.WORKING: "🔄",
            EngineerStatus.BLOCKED: "⏸️",
            EngineerStatus.ERROR: "❌",
            EngineerStatus.IDLE: "💤"
        }.get(session.status, "❓")
        print(f"   {status_icon} {session.name}: {session.status.value} - {session.task_instruction[:50]}...")
    
    print(f"\n{Colors.BLUE}📈 Overall Progress:{Colors.RESET}")
    print(f"   Completed: {completed}/{total} tasks ({percentage:.1f}%)")
    
    # Show progress bar
    bar_width = 40
    filled = int(bar_width * percentage / 100)
    bar = '█' * filled + '░' * (bar_width - filled)
    print(f"   [{bar}] {percentage:.1f}%")
    
    # Uncompleted tasks by engineer
    uncompleted = get_uncompleted_tasks(plan_data)
    if uncompleted:
        print(f"\n{Colors.YELLOW}📋 Remaining Tasks:{Colors.RESET}")
        for engineer, tasks in uncompleted.items():
            print(f"   {engineer}: {len(tasks)} task(s)")
    
    # Next actions
    print(f"\n{Colors.CYAN}🔄 Next Actions:{Colors.RESET}")
    if mode == ExecutionMode.AUTO_CONTINUE:
        print(f"   {Colors.GREEN}Continuing with remaining tasks...{Colors.RESET}")
    else:
        print(f"   {Colors.YELLOW}Waiting for your confirmation to continue{Colors.RESET}")

def print_final_report(plan_data: Dict, total_sessions: int, start_time: datetime):
    """Print final completion report"""
    completed, total, percentage = get_plan_progress(plan_data)
    duration = datetime.now() - start_time
    
    print_header("✅ FINAL REPORT - All Tasks Complete")
    
    print(f"{Colors.GREEN}🎉 Implementation Summary:{Colors.RESET}")
    print(f"   Total tasks completed: {completed}/{total}")
    print(f"   Total engineer sessions: {total_sessions}")
    print(f"   Total time taken: {duration}")
    
    print(f"\n{Colors.BLUE}📋 Completed Work by Engineer:{Colors.RESET}")
    for engineer, tasks in plan_data["engineer_checklists"].items():
        completed_tasks = [t for t in tasks if t.get("completed")]
        print(f"   {engineer}: {len(completed_tasks)} task(s)")
        for task in completed_tasks[:3]:  # Show first 3
            print(f"      ✓ {task['description'][:60]}...")
        if len(completed_tasks) > 3:
            print(f"      ... and {len(completed_tasks) - 3} more")
    
    print(f"\n{Colors.GREEN}✅ Status: All plan tasks completed successfully!{Colors.RESET}")

# =============================================================================
# Main Coordinator Loop
# =============================================================================

def coordinator_loop(
    plan_path: Path, 
    mode: ExecutionMode, 
    project_root: Path, 
    skip_prompts: bool = False,
    wait_interval: int = WAIT_INTERVAL,
    engineer_timeout: int = DEFAULT_TIMEOUT
):
    """Main coordinator execution loop"""
    
    start_time = datetime.now()
    wave = 0
    total_sessions = 0
    all_sessions: List[EngineerSession] = []
    active_sessions: List[EngineerSession] = []
    
    while True:
        wave += 1
        print_header(f"🚀 Wave {wave} - Launching Engineers")
        
        # Step 1: Re-read plan to get current state
        plan_data = parse_plan_file(plan_path)
        completed, total, percentage = get_plan_progress(plan_data)
        
        # Check if all complete
        if percentage >= 100:
            print_final_report(plan_data, total_sessions, start_time)
            break
        
        # Get uncompleted tasks
        uncompleted = get_uncompleted_tasks(plan_data)
        
        if not uncompleted:
            print_success("No remaining tasks to execute!")
            break
        
        # Step 1: Launch engineers for uncompleted tasks
        print_step(1, 5, "Launching engineers for remaining tasks")
        
        # Identify available engineers (not currently working)
        working_engineers = {s.name for s in active_sessions if s.status == EngineerStatus.WORKING}
        
        new_sessions = []
        for engineer, tasks in uncompleted.items():
            if engineer in working_engineers:
                print_info(f"{engineer} is already working - skipping")
                continue
            
            if tasks:
                # Get first uncompleted task for this engineer
                task = tasks[0]
                instruction = task["description"]
                
                session = launch_engineer_in_terminal(
                    engineer_name=engineer,
                    plan_path=str(plan_path),
                    project_root=project_root,
                    instruction=instruction,
                    timeout=engineer_timeout
                )
                
                if session:
                    new_sessions.append(session)
                    all_sessions.append(session)
                    total_sessions += 1
                
                time.sleep(2)  # Brief delay between launches
        
        active_sessions.extend(new_sessions)
        
        if not new_sessions and not active_sessions:
            print_warning("No engineers could be launched. Check plan file.")
            break
        
        # Step 2-4: Wait and monitor
        print_step(2, 5, "Monitoring engineer progress")
        
        check_count = 0
        while True:
            check_count += 1
            print_info(f"Check #{check_count} - Waiting {wait_interval}s before status check...")
            
            # Wait
            time.sleep(wait_interval)
            
            # Step 3: Check progress
            print_info("Checking engineer status...")
            
            still_active = []
            for session in active_sessions:
                status = check_engineer_session_status(session)
                session.status = status
                
                status_icon = {
                    EngineerStatus.COMPLETED: "✅",
                    EngineerStatus.WORKING: "🔄",
                    EngineerStatus.BLOCKED: "⏸️",
                    EngineerStatus.ERROR: "❌"
                }.get(status, "❓")
                
                print(f"   {status_icon} {session.name}: {status.value}")
                
                if status == EngineerStatus.WORKING:
                    still_active.append(session)
            
            # Update active sessions list
            active_sessions = still_active
            
            # If no one is working anymore, break to next wave
            if not active_sessions:
                print_success("All engineers have completed or stopped")
                break
            
            print_info(f"{len(active_sessions)} engineer(s) still working...")
        
        # Step 5: Unity Compilation Check (optional)
        print_step(3, 5, "Unity Compilation Check")
        
        if skip_prompts:
            compile_check = 'n'  # Skip compilation check in non-interactive mode
            print_info("Skipping compilation check (non-interactive mode)")
        else:
            compile_check = input(f"{Colors.CYAN}Run Unity compilation check? [y/N]: {Colors.RESET}").strip().lower()
        if compile_check in ['y', 'yes']:
            run_unity_compilation_check(project_root)
            
            # Poll until compilation complete
            print_info("Polling compilation status...")
            for _ in range(10):  # Max 10 attempts
                time.sleep(15)
                status = poll_unity_compilation_status()
                if status is True:
                    print_success("Compilation complete!")
                    break
                elif status is False:
                    print_info("Still compiling...")
            
            # Check for errors
            errors, warnings, messages = check_unity_console_errors()
            if errors > 0:
                print_error(f"Found {errors} error(s), {warnings} warning(s)")
                for msg in messages[:5]:
                    print(f"   {Colors.RED}{msg}{Colors.RESET}")
            elif errors == 0:
                print_success(f"No errors! ({warnings} warnings)")
        
        # Step 4: Re-read plan to update progress
        print_step(4, 5, "Updating progress from plan file")
        plan_data = parse_plan_file(plan_path)
        
        # Step 5: Progress Report
        print_step(5, 5, "Progress Report")
        print_progress_report(wave, plan_data, all_sessions[-len(new_sessions):] if new_sessions else all_sessions[-5:], mode)
        
        # Check completion
        completed, total, percentage = get_plan_progress(plan_data)
        if percentage >= 100:
            print_final_report(plan_data, total_sessions, start_time)
            break
        
        # Decision based on mode
        if mode == ExecutionMode.INTERACTIVE and not skip_prompts:
            if not ask_continue():
                print_info("Stopping as requested. You can resume later.")
                break
        else:
            print_info("AUTO-CONTINUE: Moving to next wave...")
            time.sleep(3)

# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Agentic Planning Coordinator - Manage AI engineers to execute plans",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python3 coordinator.py _AiDevLog/Plans/Match3_ImplementationPlan.md
    python3 coordinator.py _AiDevLog/Plans/BugFix_Plan.md --mode auto
    python3 coordinator.py _AiDevLog/Plans/Feature_Plan.md --mode interactive
        """
    )
    
    parser.add_argument(
        "plan_file",
        help="Path to the plan markdown file"
    )
    parser.add_argument(
        "--mode", "-m",
        choices=["auto", "interactive"],
        help="Execution mode (auto-continue or interactive). If not specified, will prompt."
    )
    parser.add_argument(
        "--project-root", "-p",
        help="Project root directory (default: auto-detect)"
    )
    parser.add_argument(
        "--yes", "-y",
        action="store_true",
        help="Skip confirmation prompts (non-interactive mode)"
    )
    parser.add_argument(
        "--wait", "-w",
        type=int,
        default=WAIT_INTERVAL,
        help=f"Seconds to wait between status checks (default: {WAIT_INTERVAL})"
    )
    parser.add_argument(
        "--timeout", "-t",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"Timeout for each engineer session in seconds (default: {DEFAULT_TIMEOUT})"
    )
    
    args = parser.parse_args()
    
    # Print banner
    print(f"""
{Colors.CYAN}╔═══════════════════════════════════════════════════════════╗
║     🤖 Agentic Planning Coordinator                        ║
║     Managing AI Engineers for Plan Execution               ║
╚═══════════════════════════════════════════════════════════╝{Colors.RESET}
""")
    
    # Get project root
    if args.project_root:
        project_root = Path(args.project_root)
    else:
        project_root = get_project_root()
    
    print_info(f"Project root: {project_root}")
    
    # Resolve plan path
    plan_path = Path(args.plan_file)
    if not plan_path.is_absolute():
        plan_path = project_root / plan_path
    
    if not plan_path.exists():
        print_error(f"Plan file not found: {plan_path}")
        sys.exit(1)
    
    print_info(f"Plan file: {plan_path}")
    
    # Parse and validate plan
    try:
        plan_data = parse_plan_file(plan_path)
        completed, total, percentage = get_plan_progress(plan_data)
        
        print_success(f"Plan loaded: {plan_data.get('title', 'Untitled')}")
        print_info(f"Engineers needed: {', '.join(plan_data['engineers_needed']) or 'Not specified'}")
        print_info(f"Current progress: {completed}/{total} tasks ({percentage:.1f}%)")
        
        if percentage >= 100:
            print_success("This plan is already complete!")
            sys.exit(0)
            
    except Exception as e:
        print_error(f"Failed to parse plan: {e}")
        sys.exit(1)
    
    # Get execution mode
    if args.mode:
        mode = ExecutionMode.AUTO_CONTINUE if args.mode == "auto" else ExecutionMode.INTERACTIVE
        print_info(f"Using {mode.value} mode (from command line)")
    else:
        mode = ask_execution_mode()
    
    # Confirm start
    print(f"\n{Colors.YELLOW}Ready to start coordinator?{Colors.RESET}")
    print(f"   Plan: {plan_path.name}")
    print(f"   Mode: {mode.value}")
    print(f"   Engineers: {', '.join(plan_data['engineers_needed'])}")
    
    if args.yes:
        print_info("Skipping confirmation (--yes flag)")
    else:
        confirm = input(f"\n{Colors.CYAN}Start execution? [Y/n]: {Colors.RESET}").strip().lower()
        if confirm in ['n', 'no']:
            print_info("Cancelled by user")
            sys.exit(0)
    
    # Run the coordinator loop
    try:
        coordinator_loop(
            plan_path, 
            mode, 
            project_root, 
            skip_prompts=args.yes,
            wait_interval=args.wait,
            engineer_timeout=args.timeout
        )
    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}Interrupted by user (Ctrl+C){Colors.RESET}")
        print_info("Engineers may still be running. Use 'pkill -f \"cursor agent\"' to stop all.")
        sys.exit(130)
    except Exception as e:
        print_error(f"Coordinator error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    print(f"\n{Colors.GREEN}Coordinator session complete!{Colors.RESET}")

if __name__ == "__main__":
    main()

