using System;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
#if UNITY_EDITOR_WIN
using System.Runtime.InteropServices;
#endif

namespace ApcBridge
{
    /// <summary>
    /// Handles Unity Editor operations: scenes, play mode, compilation.
    /// All operations are async and report results back to daemon.
    /// </summary>
    public static class EditorController
    {
        #region Scene Operations
        
        /// <summary>
        /// Load a scene by path
        /// </summary>
        /// <param name="scenePath">Path relative to project (e.g., "Assets/Scenes/Main.unity")</param>
        public static async Task<ApcResponse> LoadSceneAsync(string scenePath)
        {
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            // Validate path
            if (!File.Exists(Path.Combine(Application.dataPath, "..", scenePath)))
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Scene not found: {scenePath}"
                };
            }
            
            var opId = StateManager.Instance.StartOperation("loadScene");
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                // Exit play mode if needed
                if (EditorApplication.isPlaying)
                {
                    EditorApplication.ExitPlaymode();
                    await WaitForConditionAsync(() => !EditorApplication.isPlaying, 5000);
                }
                
                // Save current scene if dirty
                if (EditorSceneManager.GetActiveScene().isDirty)
                {
                    EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo();
                }
                
                // Load the scene
                var scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
                
                StateManager.Instance.CompleteOperation(opId, true);
                
                return new ApcResponse
                {
                    success = true,
                    data = new
                    {
                        operationId = opId,
                        sceneName = scene.name,
                        scenePath = scene.path
                    }
                };
            }
            catch (Exception ex)
            {
                StateManager.Instance.CompleteOperation(opId, false);
                return new ApcResponse
                {
                    success = false,
                    error = ex.Message
                };
            }
        }
        
        /// <summary>
        /// Create a new scene
        /// </summary>
        public static async Task<ApcResponse> CreateSceneAsync(string sceneName, string folderPath)
        {
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            var opId = StateManager.Instance.StartOperation("createScene");
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                // Ensure folder exists
                string fullFolderPath = Path.Combine(Application.dataPath, "..", folderPath);
                if (!Directory.Exists(fullFolderPath))
                {
                    Directory.CreateDirectory(fullFolderPath);
                    AssetDatabase.Refresh();
                }
                
                string scenePath = $"{folderPath}/{sceneName}.unity";
                string fullScenePath = Path.Combine(Application.dataPath, "..", scenePath);
                
                // Check if scene already exists
                if (File.Exists(fullScenePath))
                {
                    StateManager.Instance.CompleteOperation(opId, true);
                    return new ApcResponse
                    {
                        success = true,
                        message = "Scene already exists",
                        data = new { scenePath, exists = true }
                    };
                }
                
                // Create new scene
                var newScene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
                
                // Save the scene
                bool saved = EditorSceneManager.SaveScene(newScene, scenePath);
                
                if (saved)
                {
                    StateManager.Instance.CompleteOperation(opId, true);
                    return new ApcResponse
                    {
                        success = true,
                        data = new
                        {
                            operationId = opId,
                            sceneName,
                            scenePath
                        }
                    };
                }
                else
                {
                    StateManager.Instance.CompleteOperation(opId, false);
                    return new ApcResponse
                    {
                        success = false,
                        error = "Failed to save scene"
                    };
                }
            }
            catch (Exception ex)
            {
                StateManager.Instance.CompleteOperation(opId, false);
                return new ApcResponse
                {
                    success = false,
                    error = ex.Message
                };
            }
        }
        
        /// <summary>
        /// Get the currently active scene
        /// </summary>
        public static (string name, string path) GetActiveScene()
        {
            var scene = SceneManager.GetActiveScene();
            return (scene.name, scene.path);
        }
        
        #endregion
        
        #region Compilation
        
        /// <summary>
        /// Trigger a script compilation refresh.
        /// Returns immediately after starting - daemon should wait for compileComplete event.
        /// </summary>
        public static async Task<ApcResponse> TriggerCompileAsync()
        {
            if (EditorApplication.isCompiling)
            {
                return new ApcResponse
                {
                    success = true,
                    message = "Already compiling"
                };
            }
            
            try
            {
                // Request script compilation - this triggers Unity to recompile
                AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
                
                // Brief delay to let compilation start
                await Task.Delay(100);
                
                // Return immediately - don't wait for compilation to complete
                // The daemon will wait for the compileComplete event from StateManager
                return new ApcResponse
                {
                    success = true,
                    data = new { 
                        compiling = EditorApplication.isCompiling,
                        message = "Compilation triggered"
                    }
                };
            }
            catch (Exception ex)
            {
                return new ApcResponse
                {
                    success = false,
                    error = ex.Message
                };
            }
        }
        
        /// <summary>
        /// Reimport all assets and compile
        /// </summary>
        public static async Task<ApcResponse> ReimportAllAsync()
        {
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            var opId = StateManager.Instance.StartOperation("reimportAll");
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                AssetDatabase.ImportAsset("Assets", ImportAssetOptions.ImportRecursive | ImportAssetOptions.ForceUpdate);
                
                // Wait for any compilation
                await Task.Delay(1000);
                await WaitForConditionAsync(() => !EditorApplication.isCompiling && !EditorApplication.isUpdating, 300000);
                
                StateManager.Instance.CompleteOperation(opId, true);
                
                return new ApcResponse
                {
                    success = true,
                    data = new { operationId = opId }
                };
            }
            catch (Exception ex)
            {
                StateManager.Instance.CompleteOperation(opId, false);
                return new ApcResponse
                {
                    success = false,
                    error = ex.Message
                };
            }
        }
        
        #endregion
        
        #region Editor Focus
        
#if UNITY_EDITOR_WIN
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
        
        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        
        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);
        
        [DllImport("user32.dll")]
        private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
        
        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);
        
        [DllImport("user32.dll")]
        private static extern bool FlashWindow(IntPtr hWnd, bool bInvert);
        
        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        
        [DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(int dwProcessId);
        
        [DllImport("user32.dll")]
        private static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
        
        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        
        [DllImport("user32.dll")]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        
        private const int SW_RESTORE = 9;
        private const int SW_SHOW = 5;
        private const int SW_SHOWNOACTIVATE = 4;
        
        private const byte VK_MENU = 0x12; // Alt key
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        
        private const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
        private const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
        private const uint SPIF_SENDCHANGE = 0x0002;
        
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_SHOWWINDOW = 0x0040;
        
        private const int ASFW_ANY = -1;
#endif
        
        /// <summary>
        /// Focus the Unity Editor window and bring to foreground.
        /// Uses multiple aggressive techniques to overcome Windows SetForegroundWindow restrictions.
        /// </summary>
        public static void FocusEditor()
        {
            // Don't use delayCall - we need this to run immediately
            try
            {
#if UNITY_EDITOR_WIN
                FocusEditorWindows();
#else
                // On other platforms, just focus any window
                EditorWindow.FocusWindowIfItsOpen<SceneView>();
#endif
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] FocusEditor error: {ex.Message}");
            }
        }
        
#if UNITY_EDITOR_WIN
        /// <summary>
        /// Windows-specific focus implementation with multiple fallback techniques.
        /// </summary>
        private static void FocusEditorWindows()
        {
            var process = System.Diagnostics.Process.GetCurrentProcess();
            var hWnd = process.MainWindowHandle;
            
            if (hWnd == IntPtr.Zero)
            {
                // Try to find Unity window by enumerating windows for this process
                hWnd = FindUnityMainWindow(process.Id);
            }
            
            if (hWnd == IntPtr.Zero)
            {
                Debug.LogWarning("[APC] FocusEditor: Could not find Unity window handle");
                FocusEditorWindowInternal();
                return;
            }
            
            Debug.Log($"[APC] FocusEditor: Attempting to focus window handle {hWnd}");
            
            // TECHNIQUE 1: Disable foreground lock timeout temporarily
            uint oldTimeout = 0;
            SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ref oldTimeout, 0);
            uint zero = 0;
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ref zero, SPIF_SENDCHANGE);
            
            try
            {
                // TECHNIQUE 2: Allow any process to set foreground window
                AllowSetForegroundWindow(ASFW_ANY);
                
                // TECHNIQUE 3: Simulate Alt key press
                keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
                keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
                
                // Get foreground window info for thread attachment
                var foregroundWindow = GetForegroundWindow();
                uint foregroundThread = GetWindowThreadProcessId(foregroundWindow, out _);
                uint currentThread = GetCurrentThreadId();
                
                bool attached = false;
                if (foregroundThread != currentThread && foregroundThread != 0)
                {
                    attached = AttachThreadInput(currentThread, foregroundThread, true);
                }
                
                try
                {
                    // Restore if minimized
                    if (IsIconic(hWnd))
                    {
                        ShowWindow(hWnd, SW_RESTORE);
                    }
                    else
                    {
                        ShowWindow(hWnd, SW_SHOW);
                    }
                    
                    // TECHNIQUE 4: Temporarily make topmost then remove topmost
                    SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    
                    // TECHNIQUE 5: Standard focus methods
                    BringWindowToTop(hWnd);
                    SetForegroundWindow(hWnd);
                    SwitchToThisWindow(hWnd, true);
                    
                    // Check result
                    if (GetForegroundWindow() != hWnd)
                    {
                        // Flash as last resort to get user attention
                        FlashWindow(hWnd, true);
                        Debug.Log("[APC] FocusEditor: Window flash triggered (focus may have failed)");
                    }
                    else
                    {
                        Debug.Log("[APC] FocusEditor: Successfully brought Unity to foreground");
                    }
                }
                finally
                {
                    if (attached)
                    {
                        AttachThreadInput(currentThread, foregroundThread, false);
                    }
                }
            }
            finally
            {
                // Restore foreground lock timeout
                SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ref oldTimeout, SPIF_SENDCHANGE);
            }
            
            // Also focus Unity's internal editor window
            FocusEditorWindowInternal();
        }
        
        /// <summary>
        /// Find Unity's main window by process ID
        /// </summary>
        private static IntPtr FindUnityMainWindow(int processId)
        {
            IntPtr foundWindow = IntPtr.Zero;
            
            EnumWindows((hWnd, lParam) =>
            {
                GetWindowThreadProcessId(hWnd, out uint windowProcessId);
                if (windowProcessId == processId)
                {
                    foundWindow = hWnd;
                    return false; // Stop enumeration
                }
                return true; // Continue
            }, IntPtr.Zero);
            
            return foundWindow;
        }
        
        /// <summary>
        /// Focus Unity's internal editor window
        /// </summary>
        private static void FocusEditorWindowInternal()
        {
            try
            {
                var editorWindow = EditorWindow.focusedWindow ?? EditorWindow.GetWindow<SceneView>();
                editorWindow?.Focus();
            }
            catch
            {
                // Ignore focus errors
            }
        }
#endif
        
        #endregion
        
        #region Console Access
        
        /// <summary>
        /// Get console log entries
        /// </summary>
        /// <param name="count">Maximum number of entries to return</param>
        public static ApcResponse GetConsoleEntries(int count = 100)
        {
            try
            {
                var errors = new System.Collections.Generic.List<object>();
                var warnings = new System.Collections.Generic.List<object>();
                
                // Use reflection to access internal LogEntries API
                var logEntriesType = System.Type.GetType("UnityEditor.LogEntries,UnityEditor");
                if (logEntriesType != null)
                {
                    var getCountMethod = logEntriesType.GetMethod("GetCount", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    var startGettingEntriesMethod = logEntriesType.GetMethod("StartGettingEntries", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    var getEntryInternalMethod = logEntriesType.GetMethod("GetEntryInternal", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    var endGettingEntriesMethod = logEntriesType.GetMethod("EndGettingEntries", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    
                    if (getCountMethod != null && startGettingEntriesMethod != null && getEntryInternalMethod != null && endGettingEntriesMethod != null)
                    {
                        int totalCount = (int)getCountMethod.Invoke(null, null);
                        int startIndex = Math.Max(0, totalCount - count);
                        
                        startGettingEntriesMethod.Invoke(null, null);
                        
                        // Get LogEntry type for creating instances
                        var logEntryType = System.Type.GetType("UnityEditor.LogEntry,UnityEditor");
                        if (logEntryType != null)
                        {
                            for (int i = startIndex; i < totalCount; i++)
                            {
                                var entry = Activator.CreateInstance(logEntryType);
                                getEntryInternalMethod.Invoke(null, new object[] { i, entry });
                                
                                // Read fields from LogEntry
                                var messageField = logEntryType.GetField("message", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
                                var modeField = logEntryType.GetField("mode", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
                                var fileField = logEntryType.GetField("file", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
                                var lineField = logEntryType.GetField("line", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
                                
                                string message = messageField?.GetValue(entry) as string ?? "";
                                int mode = (int)(modeField?.GetValue(entry) ?? 0);
                                string file = fileField?.GetValue(entry) as string ?? "";
                                int line = (int)(lineField?.GetValue(entry) ?? 0);
                                
                                // Parse error code from message (e.g., "CS0001:")
                                string code = "";
                                if (message.Length > 8 && message[0] == 'C' && message[1] == 'S')
                                {
                                    int colonIdx = message.IndexOf(':');
                                    if (colonIdx > 0 && colonIdx < 10)
                                    {
                                        code = message.Substring(0, colonIdx);
                                    }
                                }
                                
                                // mode & 1 = Error, mode & 2 = Warning
                                bool isError = (mode & 1) != 0;
                                bool isWarning = (mode & 2) != 0;
                                
                                if (isError)
                                {
                                    errors.Add(new { code, message, file, line });
                                }
                                else if (isWarning)
                                {
                                    warnings.Add(new { code, message, file, line });
                                }
                            }
                        }
                        
                        endGettingEntriesMethod.Invoke(null, null);
                    }
                }
                
                return new ApcResponse
                {
                    success = true,
                    data = new { errors, warnings }
                };
            }
            catch (Exception ex)
            {
                return new ApcResponse
                {
                    success = false,
                    error = ex.Message
                };
            }
        }
        
        #endregion
        
        #region Helpers
        
        private static async Task WaitForConditionAsync(Func<bool> condition, int timeoutMs)
        {
            var startTime = DateTime.Now;
            while (!condition())
            {
                if ((DateTime.Now - startTime).TotalMilliseconds > timeoutMs)
                {
                    throw new TimeoutException("Condition not met within timeout");
                }
                await Task.Delay(100);
            }
        }
        
        #endregion
    }
}

