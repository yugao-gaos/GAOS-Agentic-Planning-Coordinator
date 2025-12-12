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
        /// Trigger a script compilation refresh
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
            
            var opId = StateManager.Instance.StartOperation("compile");
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                // Request script compilation
                AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
                
                // Wait for compilation to start
                await Task.Delay(500);
                
                // Wait for compilation to complete
                await WaitForConditionAsync(() => !EditorApplication.isCompiling, 120000); // 2 minute timeout
                
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
        
        private const int SW_RESTORE = 9;
        private const int SW_SHOW = 5;
#endif
        
        /// <summary>
        /// Focus the Unity Editor window and bring to foreground
        /// </summary>
        public static void FocusEditor()
        {
            EditorApplication.delayCall += () =>
            {
                try
                {
#if UNITY_EDITOR_WIN
                    // Get the Unity main window handle
                    var process = System.Diagnostics.Process.GetCurrentProcess();
                    var hWnd = process.MainWindowHandle;
                    
                    if (hWnd != IntPtr.Zero)
                    {
                        // Get foreground window thread
                        var foregroundWindow = GetForegroundWindow();
                        var foregroundThread = GetWindowThreadProcessId(foregroundWindow, IntPtr.Zero);
                        var currentThread = GetCurrentThreadId();
                        
                        // Attach thread input to allow SetForegroundWindow
                        if (foregroundThread != currentThread)
                        {
                            AttachThreadInput(currentThread, foregroundThread, true);
                        }
                        
                        // Show and bring to foreground
                        ShowWindow(hWnd, SW_RESTORE);
                        SetForegroundWindow(hWnd);
                        
                        // Detach thread input
                        if (foregroundThread != currentThread)
                        {
                            AttachThreadInput(currentThread, foregroundThread, false);
                        }
                    }
                    
                    // Also focus an editor window
                    var editorWindow = EditorWindow.focusedWindow ?? EditorWindow.GetWindow<SceneView>();
                    editorWindow?.Focus();
#else
                    // On other platforms, just focus any window
                    EditorWindow.FocusWindowIfItsOpen<SceneView>();
#endif
                }
                catch
                {
                    // Ignore focus errors
                }
            };
        }
        
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

