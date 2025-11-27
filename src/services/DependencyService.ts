import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export interface DependencyStatus {
    name: string;
    installed: boolean;
    version?: string;
    required: boolean;
    installUrl?: string;
    installCommand?: string;
    description: string;
    platform: 'darwin' | 'win32' | 'linux' | 'all';
}

export class DependencyService {
    private static instance: DependencyService;
    private cachedStatus: DependencyStatus[] = [];
    private _onStatusChanged = new vscode.EventEmitter<void>();
    readonly onStatusChanged = this._onStatusChanged.event;

    static getInstance(): DependencyService {
        if (!DependencyService.instance) {
            DependencyService.instance = new DependencyService();
        }
        return DependencyService.instance;
    }

    async checkAllDependencies(): Promise<DependencyStatus[]> {
        const platform = process.platform as 'darwin' | 'win32' | 'linux';
        const dependencies: DependencyStatus[] = [];

        // Platform-specific dependencies
        if (platform === 'darwin') {
            dependencies.push(await this.checkAppleScript());
            dependencies.push(await this.checkAccessibilityPermission());
        } else if (platform === 'win32') {
            dependencies.push(await this.checkPowerShell());
        } else if (platform === 'linux') {
            dependencies.push(await this.checkXdotool());
        }

        // Common dependencies
        dependencies.push(await this.checkPython());
        dependencies.push(await this.checkCursorCli());
        dependencies.push(await this.checkApcCli());

        this.cachedStatus = dependencies;
        this._onStatusChanged.fire();
        return dependencies;
    }

    private async checkApcCli(): Promise<DependencyStatus> {
        try {
            await execAsync('which apc || where apc 2>nul');
            return {
                name: 'APC CLI (apc)',
                installed: true,
                required: true,
                description: 'apc command-line tool for AI agents',
                platform: 'all'
            };
        } catch {
            return {
                name: 'APC CLI (apc)',
                installed: false,
                required: true,
                description: 'Click to install → creates apc command in ~/.local/bin',
                platform: 'all'
            };
        }
    }

    async installApcCli(extensionPath: string): Promise<{ success: boolean; message: string }> {
        const platform = process.platform;
        const sourcePath = path.join(extensionPath, 'scripts', 'apc');
        
        // Determine target directory
        let targetDir: string;
        let targetPath: string;
        
        if (platform === 'win32') {
            // Windows: Use AppData\Local\Microsoft\WindowsApps or create ~/bin
            targetDir = path.join(os.homedir(), 'bin');
            targetPath = path.join(targetDir, 'apc.cmd');
        } else {
            // macOS/Linux: Use ~/.local/bin (standard user bin location)
            targetDir = path.join(os.homedir(), '.local', 'bin');
            targetPath = path.join(targetDir, 'apc');
        }

        try {
            // Ensure target directory exists
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            if (platform === 'win32') {
                // Windows: Create a .cmd wrapper
                const cmdContent = `@echo off\nbash "${sourcePath}" %*`;
                fs.writeFileSync(targetPath, cmdContent);
            } else {
                // Unix: Create a symlink
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                }
                fs.symlinkSync(sourcePath, targetPath);
                // Make sure source is executable
                fs.chmodSync(sourcePath, '755');
            }

            // Check if targetDir is in PATH
            const pathEnv = process.env.PATH || '';
            const inPath = pathEnv.split(path.delimiter).includes(targetDir);

            if (!inPath) {
                const shellConfig = platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
                return {
                    success: true,
                    message: `APC CLI installed to ${targetPath}.\n\nAdd to PATH by running:\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ${shellConfig}\n\nThen restart your terminal or run: source ${shellConfig}`
                };
            }

            return {
                success: true,
                message: `APC CLI installed successfully to ${targetPath}`
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to install APC CLI: ${error}`
            };
        }
    }

    async uninstallApcCli(): Promise<{ success: boolean; message: string }> {
        const platform = process.platform;
        let targetPath: string;

        if (platform === 'win32') {
            targetPath = path.join(os.homedir(), 'bin', 'apc.cmd');
        } else {
            targetPath = path.join(os.homedir(), '.local', 'bin', 'apc');
        }

        try {
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
                return { success: true, message: `APC CLI removed from ${targetPath}` };
            }
            return { success: true, message: 'APC CLI was not installed' };
        } catch (error) {
            return { success: false, message: `Failed to uninstall: ${error}` };
        }
    }

    getCachedStatus(): DependencyStatus[] {
        return this.cachedStatus;
    }

    areAllRequiredMet(): boolean {
        const platform = process.platform;
        return this.cachedStatus
            .filter(d => d.required && (d.platform === platform || d.platform === 'all'))
            .every(d => d.installed);
    }

    private async checkAppleScript(): Promise<DependencyStatus> {
        try {
            await execAsync('osascript -e "return 1"');
            return {
                name: 'AppleScript',
                installed: true,
                required: true,
                description: 'macOS automation (built-in)',
                platform: 'darwin'
            };
        } catch {
            return {
                name: 'AppleScript',
                installed: false,
                required: true,
                description: 'macOS automation - should be built-in',
                platform: 'darwin'
            };
        }
    }

    private async checkAccessibilityPermission(): Promise<DependencyStatus> {
        // Test if we can send keystrokes via System Events
        try {
            // This will fail if accessibility permission is not granted
            await execAsync('osascript -e \'tell application "System Events" to return name of first process\'');
            return {
                name: 'Accessibility Permission',
                installed: true,
                required: true,
                description: 'Required for keyboard automation',
                platform: 'darwin',
                installUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            };
        } catch {
            return {
                name: 'Accessibility Permission',
                installed: false,
                required: true,
                description: 'Grant Cursor accessibility permission in System Settings',
                platform: 'darwin',
                installUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            };
        }
    }

    private async checkPowerShell(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('powershell -Command "$PSVersionTable.PSVersion.ToString()"');
            return {
                name: 'PowerShell',
                installed: true,
                version: stdout.trim(),
                required: true,
                description: 'Windows automation (built-in)',
                platform: 'win32'
            };
        } catch {
            return {
                name: 'PowerShell',
                installed: false,
                required: true,
                description: 'Windows PowerShell - should be built-in',
                platform: 'win32',
                installUrl: 'https://docs.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows'
            };
        }
    }

    private async checkXdotool(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('xdotool --version');
            const version = stdout.split('\n')[0]?.replace('xdotool version ', '').trim();
            return {
                name: 'xdotool',
                installed: true,
                version,
                required: true,
                description: 'Linux keyboard automation',
                platform: 'linux'
            };
        } catch {
            return {
                name: 'xdotool',
                installed: false,
                required: true,
                description: 'Required for keyboard automation on Linux',
                platform: 'linux',
                installCommand: 'sudo apt install xdotool',
                installUrl: 'https://github.com/jordansissel/xdotool'
            };
        }
    }

    private async checkPython(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('python3 --version');
            const version = stdout.trim().replace('Python ', '');
            return {
                name: 'Python 3',
                installed: true,
                version,
                required: true,
                description: 'Required for coordinator script',
                platform: 'all',
                installUrl: 'https://www.python.org/downloads/'
            };
        } catch {
            try {
                // Try 'python' command on Windows
                const { stdout } = await execAsync('python --version');
                if (stdout.includes('Python 3')) {
                    return {
                        name: 'Python 3',
                        installed: true,
                        version: stdout.trim().replace('Python ', ''),
                        required: true,
                        description: 'Required for coordinator script',
                        platform: 'all'
                    };
                }
            } catch {}
            return {
                name: 'Python 3',
                installed: false,
                required: true,
                description: 'Required for coordinator script',
                platform: 'all',
                installUrl: 'https://www.python.org/downloads/'
            };
        }
    }

    private async checkCursorCli(): Promise<DependencyStatus> {
        try {
            const { stdout } = await execAsync('cursor --version');
            return {
                name: 'Cursor CLI',
                installed: true,
                version: stdout.trim(),
                required: true,
                description: 'Required for launching engineer sessions',
                platform: 'all',
                installUrl: 'cursor://settings/cli'
            };
        } catch {
            return {
                name: 'Cursor CLI',
                installed: false,
                required: true,
                description: 'Install from Cursor: Cmd/Ctrl+Shift+P → "Install cursor command"',
                platform: 'all',
                installUrl: 'cursor://settings/cli'
            };
        }
    }

    async openInstallUrl(dep: DependencyStatus): Promise<void> {
        if (dep.installUrl) {
            await vscode.env.openExternal(vscode.Uri.parse(dep.installUrl));
        }
    }

    async copyInstallCommand(dep: DependencyStatus): Promise<void> {
        if (dep.installCommand) {
            await vscode.env.clipboard.writeText(dep.installCommand);
            vscode.window.showInformationMessage(`Install command copied: ${dep.installCommand}`);
        }
    }
}

