/**
 * Cursor Backend Setup Scripts Utility
 * 
 * This utility is SPECIFIC to the Cursor backend (cursor-agent CLI).
 * Other backends (Claude API, Anthropic CLI, etc.) would have their own setup utilities.
 * 
 * Handles:
 * - Path resolution for cursor-agent installation scripts
 * - Admin elevation for WSL setup on Windows
 * - Platform-specific script execution
 */
import * as vscode from 'vscode';
import * as path from 'path';

export class CursorSetupScripts {
    /**
     * Get absolute path to install-cursor-agent script
     * @param extensionUri - The extension's URI (from context or provider)
     * @param platform - Target platform ('win32', 'darwin', 'linux')
     * @returns Absolute file system path to the script
     */
    static getInstallCursorAgentScriptPath(extensionUri: vscode.Uri, platform: string = process.platform): string {
        const scriptName = platform === 'win32' 
            ? 'install-cursor-agent.ps1' 
            : 'install-cursor-agent.sh';
        
        const scriptUri = vscode.Uri.joinPath(
            extensionUri,
            'out',
            'scripts',
            scriptName
        );
        
        return scriptUri.fsPath;
    }
    
    /**
     * Get the command string to run the install script
     * This is for display purposes or when the actual execution is handled elsewhere
     * @param platform - Target platform
     * @returns Command string (note: uses relative path for display, actual execution should use absolute path)
     */
    static getInstallCursorAgentCommand(platform: string = process.platform): string {
        if (platform === 'win32') {
            return 'powershell -ExecutionPolicy Bypass -File <extension>/out/scripts/install-cursor-agent.ps1';
        } else {
            return 'bash <extension>/out/scripts/install-cursor-agent.sh';
        }
    }
    
    /**
     * Execute the cursor-agent install script with admin privileges
     * @param extensionUri - The extension's URI
     * @param terminal - VS Code terminal to use
     * @returns The command that was sent to the terminal
     */
    static executeInstallScriptAsAdmin(extensionUri: vscode.Uri, terminal: vscode.Terminal): string {
        const fullPath = CursorSetupScripts.getInstallCursorAgentScriptPath(extensionUri);
        const platform = process.platform;
        
        if (platform === 'win32') {
            // Windows: Use Start-Process with RunAs to request admin
            const command = `Start-Process powershell.exe -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-NoProfile','-File','"${fullPath}"'`;
            terminal.sendText(command);
            return command;
        } else {
            // Unix-like: Use sudo
            const command = `sudo bash "${fullPath}"`;
            terminal.sendText(command);
            return command;
        }
    }
}

