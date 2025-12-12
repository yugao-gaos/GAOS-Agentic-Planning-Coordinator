using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace ApcBridge
{
    /// <summary>
    /// Main entry point for APC Unity Bridge.
    /// Manages connection lifecycle, command handling, and event dispatch.
    /// </summary>
    [InitializeOnLoad]
    public class ApcUnityBridge
    {
        #region Singleton
        
        private static ApcUnityBridge _instance;
        public static ApcUnityBridge Instance => _instance;
        
        #endregion
        
        #region State
        
        private DaemonConnection _connection;
        private bool _isRegistered = false;
        private string _clientId;
        
        #endregion
        
        #region Properties
        
        public bool IsConnected => _connection?.IsConnected ?? false;
        public bool IsRegistered => _isRegistered;
        public ConnectionStatus ConnectionStatus => _connection?.Status ?? ConnectionStatus.Disconnected;
        public string ClientId => _clientId;
        
        #endregion
        
        #region Static Constructor (InitializeOnLoad)
        
        static ApcUnityBridge()
        {
            // Initialize on editor load
            EditorApplication.delayCall += Initialize;
        }
        
        private static void Initialize()
        {
            if (_instance != null) return;
            
            _instance = new ApcUnityBridge();
            _instance.Setup();
            
            // Cleanup on domain reload
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
            EditorApplication.quitting += OnEditorQuitting;
            
            Debug.Log("[APC] Unity Bridge initialized");
        }
        
        private static void OnBeforeAssemblyReload()
        {
            _instance?.Shutdown();
        }
        
        private static void OnEditorQuitting()
        {
            _instance?.Shutdown();
        }
        
        #endregion
        
        #region Setup/Shutdown
        
        private void Setup()
        {
            _connection = new DaemonConnection();
            _connection.OnStatusChanged += OnConnectionStatusChanged;
            _connection.OnEventReceived += OnEventReceived;
            _connection.OnResponseReceived += OnResponseReceived;
            _connection.OnRequestReceived += OnRequestReceived;
            _connection.OnError += OnConnectionError;
            
            // Load settings
            LoadSettings();
            
            // Start auto-connect if enabled
            if (ApcSettings.AutoConnect)
            {
                _ = ConnectAsync();
            }
        }
        
        private void Shutdown()
        {
            _connection?.Dispose();
            _connection = null;
            StateManager.Instance?.Dispose();
        }
        
        #endregion
        
        #region Public API
        
        /// <summary>
        /// Connect to the daemon
        /// </summary>
        public async Task<bool> ConnectAsync()
        {
            if (_connection == null) return false;
            
            bool connected = await _connection.ConnectAsync();
            
            if (connected)
            {
                // Register with daemon
                await RegisterWithDaemonAsync();
            }
            
            return connected;
        }
        
        /// <summary>
        /// Disconnect from the daemon
        /// </summary>
        public async Task DisconnectAsync()
        {
            _isRegistered = false;
            if (_connection != null)
            {
                await _connection.DisconnectAsync();
            }
        }
        
        /// <summary>
        /// Send an event to the daemon
        /// </summary>
        public void SendEvent(string eventName, object data)
        {
            _connection?.SendEvent(eventName, data);
        }
        
        /// <summary>
        /// Send a response back to the daemon
        /// </summary>
        public void SendResponse(ApcResponse response)
        {
            _connection?.SendResponse(response);
        }
        
        /// <summary>
        /// Send a request and wait for response
        /// </summary>
        public async Task<ApcResponse> SendRequestAsync(string command, Dictionary<string, object> parameters = null)
        {
            if (_connection == null)
            {
                return new ApcResponse { success = false, error = "Not initialized" };
            }
            
            var request = new ApcRequest(command, parameters);
            return await _connection.SendRequestAsync(request);
        }
        
        #endregion
        
        #region Registration
        
        private async Task RegisterWithDaemonAsync()
        {
            try
            {
                string projectPath = System.IO.Path.GetDirectoryName(Application.dataPath);
                
                var response = await SendRequestAsync(UnityDirectCommands.Register, new Dictionary<string, object>
                {
                    { "projectPath", projectPath },
                    { "unityVersion", Application.unityVersion }
                });
                
                if (response.success)
                {
                    _isRegistered = true;
                    Debug.Log("[APC] Registered with daemon successfully");
                    
                    // Push initial state
                    SendEvent(UnityEvents.StateChanged, StateManager.Instance.GetStateResponse());
                }
                else
                {
                    Debug.LogWarning($"[APC] Registration failed: {response.error}");
                    _isRegistered = false;
                    
                    // Disconnect if registration failed (workspace mismatch)
                    if (response.error?.Contains("mismatch") == true)
                    {
                        await DisconnectAsync();
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[APC] Registration error: {ex}");
                _isRegistered = false;
            }
        }
        
        #endregion
        
        #region Event Handlers
        
        private async void OnConnectionStatusChanged(ConnectionStatus status)
        {
            Debug.Log($"[APC] Connection status: {status}");
            
            if (status == ConnectionStatus.Disconnected)
            {
                _isRegistered = false;
            }
            else if (status == ConnectionStatus.Connected && !_isRegistered)
            {
                // Auto-register on reconnect
                await RegisterWithDaemonAsync();
            }
            
            // Repaint toolbar
            EditorApplication.delayCall += () =>
            {
                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
            };
        }
        
        private void OnEventReceived(ApcEvent evt)
        {
            // Handle daemon events if needed
            Debug.Log($"[APC] Event received: {evt.@event}");
        }
        
        private void OnResponseReceived(ApcResponse response)
        {
            // Check if this is a command we need to execute
            // Commands come as requests, not responses, so this is mainly for debugging
        }
        
        private void OnConnectionError(string error)
        {
            Debug.LogWarning($"[APC] Connection error: {error}");
        }
        
        private async void OnRequestReceived(ApcRequest request)
        {
            try
            {
                Debug.Log($"[APC] Request received: {request.cmd}");
                
                // Use params directly - may be null or empty
                var parameters = request.@params ?? new Dictionary<string, object>();
                
                // Handle the command
                var response = await HandleCommandAsync(request.cmd, parameters);
                response.id = request.id;
                
                // Send response back
                SendResponse(response);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[APC] Error handling request: {ex}");
                SendResponse(new ApcResponse
                {
                    id = request.id,
                    success = false,
                    error = ex.Message
                });
            }
        }
        
        #endregion
        
        #region Command Handlers
        
        /// <summary>
        /// Handle incoming command from daemon
        /// </summary>
        public async Task<ApcResponse> HandleCommandAsync(string command, Dictionary<string, object> parameters)
        {
            try
            {
                switch (command)
                {
                    case UnityDirectCommands.GetState:
                        return HandleGetState();
                    
                    case UnityDirectCommands.EnterPlayMode:
                        return await HandleEnterPlayModeAsync();
                    
                    case UnityDirectCommands.ExitPlayMode:
                        return await HandleExitPlayModeAsync();
                    
                    case UnityDirectCommands.LoadScene:
                        return await HandleLoadSceneAsync(parameters);
                    
                    case UnityDirectCommands.CreateScene:
                        return await HandleCreateSceneAsync(parameters);
                    
                    case UnityDirectCommands.RunTests:
                        return await HandleRunTestsAsync(parameters);
                    
                    case UnityDirectCommands.Compile:
                        return await HandleCompileAsync();
                    
                    case UnityDirectCommands.FocusEditor:
                        return HandleFocusEditor();
                    
                    case UnityDirectCommands.GetConsole:
                        return HandleGetConsole(parameters);
                    
                    case UnityDirectCommands.PlayerTest:
                        return await HandlePlayerTestAsync(parameters);
                    
                    case UnityDirectCommands.RunPipeline:
                        return await HandleRunPipelineAsync(parameters);
                    
                    default:
                        return new ApcResponse
                        {
                            success = false,
                            error = $"Unknown command: {command}"
                        };
                }
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
        
        private ApcResponse HandleGetState()
        {
            return new ApcResponse
            {
                success = true,
                data = StateManager.Instance.GetStateResponse()
            };
        }
        
        private async Task<ApcResponse> HandleEnterPlayModeAsync()
        {
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            var opId = StateManager.Instance.StartOperation("enterPlayMode");
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                EditorApplication.EnterPlaymode();
                
                // Wait for play mode to actually start
                await WaitForConditionAsync(() => EditorApplication.isPlaying, 10000);
                
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
                return new ApcResponse { success = false, error = ex.Message };
            }
        }
        
        private async Task<ApcResponse> HandleExitPlayModeAsync()
        {
            if (!EditorApplication.isPlaying)
            {
                return new ApcResponse { success = true, message = "Already not playing" };
            }
            
            var opId = StateManager.Instance.StartOperation("exitPlayMode");
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                EditorApplication.ExitPlaymode();
                
                await WaitForConditionAsync(() => !EditorApplication.isPlaying, 10000);
                
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
                return new ApcResponse { success = false, error = ex.Message };
            }
        }
        
        private async Task<ApcResponse> HandleLoadSceneAsync(Dictionary<string, object> parameters)
        {
            if (!parameters.TryGetValue("path", out object pathObj) || !(pathObj is string path))
            {
                return new ApcResponse { success = false, error = "Missing 'path' parameter" };
            }
            
            return await EditorController.LoadSceneAsync(path);
        }
        
        private async Task<ApcResponse> HandleCreateSceneAsync(Dictionary<string, object> parameters)
        {
            string name = parameters.TryGetValue("name", out object nameObj) ? nameObj as string : "NewScene";
            string path = parameters.TryGetValue("path", out object pathObj) ? pathObj as string : "Assets/Scenes";
            
            return await EditorController.CreateSceneAsync(name, path);
        }
        
        private async Task<ApcResponse> HandleRunTestsAsync(Dictionary<string, object> parameters)
        {
            string mode = parameters.TryGetValue("mode", out object modeObj) ? modeObj as string : "EditMode";
            string[] filter = null;
            
            if (parameters.TryGetValue("filter", out object filterObj) && filterObj is string[] filterArray)
            {
                filter = filterArray;
            }
            
            return await TestController.RunTestsAsync(mode, filter);
        }
        
        private async Task<ApcResponse> HandleCompileAsync()
        {
            return await EditorController.TriggerCompileAsync();
        }
        
        private ApcResponse HandleFocusEditor()
        {
            EditorController.FocusEditor();
            return new ApcResponse { success = true };
        }
        
        private ApcResponse HandleGetConsole(Dictionary<string, object> parameters)
        {
            int count = 100;
            if (parameters != null && parameters.TryGetValue("count", out object countObj))
            {
                if (countObj is int c) count = c;
                else if (countObj is long l) count = (int)l;
                else if (countObj is double d) count = (int)d;
            }
            
            return EditorController.GetConsoleEntries(count);
        }
        
        private async Task<ApcResponse> HandlePlayerTestAsync(Dictionary<string, object> parameters)
        {
            string pipelineId = parameters?.TryGetValue("pipelineId", out object pidObj) == true 
                ? pidObj as string : "unknown";
            string scenePath = parameters?.TryGetValue("scenePath", out object sceneObj) == true 
                ? sceneObj as string : "Assets/Scenes/Main.unity";
            
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            try
            {
                // Show popup and wait for user to click "Start Testing"
                var startAction = await UI.PlayerTestPopup.ShowAndWaitAsync(pipelineId, scenePath);
                
                if (startAction == "cancel")
                {
                    return new ApcResponse
                    {
                        success = false,
                        error = "Player test cancelled by user",
                        data = new { action = "cancel", phase = "start" }
                    };
                }
                
                // Load scene and enter play mode
                var loadResult = await EditorController.LoadSceneAsync(scenePath);
                if (!loadResult.success)
                {
                    return new ApcResponse
                    {
                        success = false,
                        error = $"Failed to load scene: {loadResult.error}"
                    };
                }
                
                var playResult = await EditorController.EnterPlayModeAsync();
                if (!playResult.success)
                {
                    return new ApcResponse
                    {
                        success = false,
                        error = $"Failed to enter play mode: {playResult.error}"
                    };
                }
                
                // Transition popup to "playing" phase
                UI.PlayerTestPopup.TransitionToPlaying();
                
                // Wait for user to finish testing
                var finishAction = await UI.PlayerTestPopup.ShowAndWaitAsync(pipelineId, scenePath);
                
                // Exit play mode
                await EditorController.ExitPlayModeAsync();
                
                return new ApcResponse
                {
                    success = finishAction == "finish",
                    data = new { 
                        action = finishAction,
                        phase = "finish"
                    }
                };
            }
            catch (Exception ex)
            {
                // Try to exit play mode on error
                if (EditorApplication.isPlaying)
                {
                    await EditorController.ExitPlayModeAsync();
                }
                
                return new ApcResponse
                {
                    success = false,
                    error = ex.Message
                };
            }
        }
        
        private async Task<ApcResponse> HandleRunPipelineAsync(Dictionary<string, object> parameters)
        {
            string pipelineId = parameters?.TryGetValue("pipelineId", out object pidObj) == true 
                ? pidObj as string : $"pip_{DateTime.Now:yyyyMMddHHmmss}";
            
            string[] operations = null;
            if (parameters?.TryGetValue("operations", out object opsObj) == true)
            {
                if (opsObj is string[] opsArray)
                {
                    operations = opsArray;
                }
                else if (opsObj is List<object> opsList)
                {
                    operations = opsList.ConvertAll(o => o?.ToString()).ToArray();
                }
                else if (opsObj is object[] opsObjArray)
                {
                    operations = Array.ConvertAll(opsObjArray, o => o?.ToString());
                }
            }
            
            if (operations == null || operations.Length == 0)
            {
                return new ApcResponse
                {
                    success = false,
                    error = "No operations specified"
                };
            }
            
            string testScene = parameters?.TryGetValue("testScene", out object sceneObj) == true 
                ? sceneObj as string : null;
            
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            try
            {
                var executor = new Pipeline.PipelineExecutor(pipelineId, operations, testScene);
                var result = await executor.ExecuteAsync();
                
                return new ApcResponse
                {
                    success = result.Success,
                    data = new
                    {
                        success = result.Success,
                        failedAtStep = result.FailedAtStep,
                        logFolder = result.LogFolder,
                        stepResults = result.StepResults
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
        
        #endregion
        
        #region Helpers
        
        private async Task WaitForConditionAsync(Func<bool> condition, int timeoutMs)
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
        
        private void LoadSettings()
        {
            // Settings will be loaded by ApcSettings class
        }
        
        #endregion
    }
    
    /// <summary>
    /// Persistent settings for APC Unity Bridge
    /// </summary>
    public static class ApcSettings
    {
        private const string PREF_AUTO_CONNECT = "ApcBridge_AutoConnect";
        private const string PREF_SHOW_NOTIFICATIONS = "ApcBridge_ShowNotifications";
        private const string PREF_PORT = "ApcBridge_Port";
        
        public static bool AutoConnect
        {
            get => EditorPrefs.GetBool(PREF_AUTO_CONNECT, true);
            set => EditorPrefs.SetBool(PREF_AUTO_CONNECT, value);
        }
        
        public static bool ShowNotifications
        {
            get => EditorPrefs.GetBool(PREF_SHOW_NOTIFICATIONS, true);
            set => EditorPrefs.SetBool(PREF_SHOW_NOTIFICATIONS, value);
        }
        
        public static int Port
        {
            get => EditorPrefs.GetInt(PREF_PORT, 19840);
            set => EditorPrefs.SetInt(PREF_PORT, value);
        }
    }
}

