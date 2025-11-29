#!/usr/bin/env python3
"""
Update a specific section in the plan file using file locking.
Used by debate agents to safely write their analysis without conflicts.

Usage:
    python3 update_plan_section.py <plan_file> <section_marker> <analysis_file>
    
Example:
    python3 update_plan_section.py plan.md "🏗️ Opus Analyst" /tmp/opus_analysis.md
"""

import sys
import re
import fcntl
import os

def update_plan_section(plan_path: str, section_marker: str, analysis_path: str) -> bool:
    """
    Update a section in the plan file with content from analysis file.
    Uses file locking to prevent concurrent write conflicts.
    """
    lock_path = f"{plan_path}.lock"
    
    try:
        # Read the analysis content
        with open(analysis_path, 'r') as f:
            analysis = f.read().strip()
        
        # Open lock file and acquire exclusive lock
        with open(lock_path, 'w') as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            
            try:
                # Read current plan
                with open(plan_path, 'r') as f:
                    content = f.read()
                
                # Pattern to find this analyst's section and replace placeholder
                # Matches: ### {section_marker}...\n**Status:** ⏳ Analyzing...\n\n_Analysis pending..._
                pattern = rf'(### {re.escape(section_marker)}.*?\n\*\*Status:\*\* ⏳ Analyzing\.\.\.)\n\n_Analysis pending\.\.\._'
                
                # Replace with completed status and analysis
                replacement = rf'\1\n**Status:** ✅ Complete\n\n{analysis}'
                new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
                
                if new_content == content:
                    # Fallback: try to find section and append
                    section_pattern = rf'(### {re.escape(section_marker)}.*?)((?:\n---\n### |\n<!-- ANALYST_SECTION_END -->))'
                    
                    def append_analysis(match):
                        return match.group(1) + '\n**Status:** ✅ Complete\n\n' + analysis + match.group(2)
                    
                    new_content = re.sub(section_pattern, append_analysis, content, flags=re.DOTALL)
                
                # Write updated content
                with open(plan_path, 'w') as f:
                    f.write(new_content)
                
                print(f"✅ Updated section '{section_marker}' in {plan_path}")
                return True
                
            finally:
                # Release lock
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                
    except FileNotFoundError as e:
        print(f"❌ File not found: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"❌ Error updating plan: {e}", file=sys.stderr)
        return False

def add_tasks_to_table(plan_path: str, tasks_content: str) -> bool:
    """
    Add tasks to the task breakdown table in the plan file.
    """
    lock_path = f"{plan_path}.lock"
    
    try:
        with open(lock_path, 'w') as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            
            try:
                with open(plan_path, 'r') as f:
                    content = f.read()
                
                # Replace TBD placeholder with actual tasks
                if '| _TBD_ | _Analysts identifying tasks..._ |' in content:
                    new_content = content.replace(
                        '| _TBD_ | _Analysts identifying tasks..._ | _TBD_ | _TBD_ | _TBD_ |',
                        tasks_content
                    )
                else:
                    # Append to existing table (find last row before ---)
                    table_end_pattern = r'(\|[^\n]+\|)\n(\n---\n\n## 6\.)'
                    new_content = re.sub(
                        table_end_pattern,
                        rf'\1\n{tasks_content}\n\2',
                        content
                    )
                
                with open(plan_path, 'w') as f:
                    f.write(new_content)
                
                print(f"✅ Added tasks to table in {plan_path}")
                return True
                
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                
    except Exception as e:
        print(f"❌ Error adding tasks: {e}", file=sys.stderr)
        return False

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    
    plan_file = sys.argv[1]
    section_marker = sys.argv[2]
    analysis_file = sys.argv[3]
    
    success = update_plan_section(plan_file, section_marker, analysis_file)
    sys.exit(0 if success else 1)







