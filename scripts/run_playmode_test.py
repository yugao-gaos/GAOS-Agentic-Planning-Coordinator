#!/usr/bin/env python3
"""
Unity Play Mode Test Runner
Uses Unity MCP server to run playmode tests
"""

import requests
import json
import time
import sys

MCP_URL = "http://localhost:8080/mcp/v1"

def call_mcp_tool(tool_name, arguments=None):
    """Call an MCP tool"""
    if arguments is None:
        arguments = {}
    
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    }
    
    try:
        response = requests.post(MCP_URL, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error calling {tool_name}: {e}")
        return None

def get_editor_state():
    """Get Unity editor state"""
    print("Checking Unity editor state...")
    result = call_mcp_tool("get_unity_editor_state")
    if result and "result" in result:
        print(json.dumps(result["result"], indent=2))
        return result["result"]
    return None

def play_game():
    """Enter play mode"""
    print("Entering play mode...")
    result = call_mcp_tool("play_game")
    if result:
        print("Play mode started")
        return True
    return False

def stop_game():
    """Exit play mode"""
    print("Exiting play mode...")
    result = call_mcp_tool("stop_game")
    if result:
        print("Play mode stopped")
        return True
    return False

def get_logs(log_type="all", limit=50):
    """Get Unity console logs"""
    result = call_mcp_tool("get_unity_logs", {
        "log_type": log_type,
        "limit": limit
    })
    if result and "result" in result:
        return result["result"]
    return None

def execute_menu_item(menu_path):
    """Execute a Unity menu item"""
    print(f"Executing menu item: {menu_path}")
    result = call_mcp_tool("execute_menu_item", {
        "menu_path": menu_path
    })
    if result:
        print(f"Menu item executed: {menu_path}")
        return True
    return False

def check_compile_errors():
    """Check for compilation errors"""
    print("Checking for compilation errors...")
    result = call_mcp_tool("check_compile_errors")
    if result and "result" in result:
        errors = result["result"]
        if errors:
            print(f"Found {len(errors)} compilation errors:")
            for error in errors:
                print(f"  - {error}")
            return False
        else:
            print("No compilation errors found")
            return True
    return None

def run_playmode_test():
    """Run the playmode test sequence"""
    print("="*60)
    print("Unity Play Mode Test Runner")
    print("="*60)
    
    # Step 1: Check editor state
    state = get_editor_state()
    if not state:
        print("ERROR: Could not get editor state")
        return False
    
    # Step 2: Check for compilation errors
    if not check_compile_errors():
        print("ERROR: Compilation errors found. Fix them first.")
        return False
    
    # Step 3: Enter play mode
    if not play_game():
        print("ERROR: Could not enter play mode")
        return False
    
    print("Waiting for Unity to initialize (5 seconds)...")
    time.sleep(5)
    
    # Step 4: Check logs for test results
    print("\n" + "="*60)
    print("Checking test results...")
    print("="*60)
    
    logs = get_logs("all", 100)
    if logs:
        # Look for test-related logs
        test_logs = []
        for log in logs.get("logs", []):
            message = log.get("message", "")
            if "[Test]" in message or "Test" in message or "special gem" in message.lower():
                test_logs.append(log)
        
        if test_logs:
            print("\nTest-related logs:")
            for log in test_logs:
                log_type = log.get("type", "Log")
                message = log.get("message", "")
                print(f"[{log_type}] {message}")
        else:
            print("\nAll recent logs:")
            for log in logs.get("logs", [])[-20:]:
                log_type = log.get("type", "Log")
                message = log.get("message", "")
                print(f"[{log_type}] {message}")
    
    # Wait a bit more for test to complete
    print("\nWaiting for test to complete (5 more seconds)...")
    time.sleep(5)
    
    # Get final logs
    print("\n" + "="*60)
    print("Final test results:")
    print("="*60)
    
    logs = get_logs("all", 100)
    if logs:
        test_logs = []
        for log in logs.get("logs", []):
            message = log.get("message", "")
            if "[Test]" in message or "Test" in message or "special gem" in message.lower() or "pool" in message.lower():
                test_logs.append(log)
        
        if test_logs:
            for log in test_logs[-30:]:  # Last 30 test-related logs
                log_type = log.get("type", "Log")
                message = log.get("message", "")
                print(f"[{log_type}] {message}")
    
    # Step 5: Exit play mode
    print("\n" + "="*60)
    stop_game()
    
    print("\n" + "="*60)
    print("Test sequence complete!")
    print("="*60)
    return True

if __name__ == "__main__":
    success = run_playmode_test()
    sys.exit(0 if success else 1)
