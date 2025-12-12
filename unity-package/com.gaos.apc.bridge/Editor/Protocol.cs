using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace ApcBridge
{
    /// <summary>
    /// Protocol types matching the TypeScript ApcRequest/ApcResponse/ApcEvent definitions.
    /// Used for communication between Unity and the APC Daemon via WebSocket.
    /// </summary>
    
    #region Base Message Types
    
    /// <summary>
    /// Request message from Unity to daemon
    /// </summary>
    [Serializable]
    public class ApcRequest
    {
        public string id;
        public string cmd;
        public Dictionary<string, object> @params;
        public string clientId;
        
        public ApcRequest(string command, Dictionary<string, object> parameters = null)
        {
            id = $"req_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N").Substring(0, 7)}";
            cmd = command;
            @params = parameters ?? new Dictionary<string, object>();
        }
    }
    
    /// <summary>
    /// Response message from daemon to Unity
    /// </summary>
    [Serializable]
    public class ApcResponse
    {
        public string id;
        public bool success;
        public object data;
        public string error;
        public string message;
    }
    
    /// <summary>
    /// Event message pushed from daemon to Unity
    /// </summary>
    [Serializable]
    public class ApcEvent
    {
        public string @event;
        public object data;
        public string timestamp;
        public string sessionId;
    }
    
    /// <summary>
    /// Wrapper for WebSocket messages
    /// </summary>
    [Serializable]
    public class ApcMessage
    {
        public string type; // "request", "response", "event"
        public object payload;
    }
    
    #endregion
    
    #region Unity State Types
    
    /// <summary>
    /// Unity Editor state sent to daemon
    /// </summary>
    [Serializable]
    public class UnityStateResponse
    {
        public bool isCompiling;
        public bool isPlaying;
        public bool isPaused;
        public bool isBusy;
        public string currentOperation;
        public bool editorReady;
        public string projectPath;
        public string unityVersion;
        
        public static UnityStateResponse GetCurrentState(bool isBusy = false, string currentOp = null)
        {
            return new UnityStateResponse
            {
                isCompiling = UnityEditor.EditorApplication.isCompiling,
                isPlaying = UnityEditor.EditorApplication.isPlaying,
                isPaused = UnityEditor.EditorApplication.isPaused,
                isBusy = isBusy,
                currentOperation = currentOp,
                editorReady = !UnityEditor.EditorApplication.isUpdating && !UnityEditor.EditorApplication.isCompiling,
                projectPath = System.IO.Path.GetDirectoryName(Application.dataPath),
                unityVersion = Application.unityVersion
            };
        }
    }
    
    /// <summary>
    /// Registration request sent when Unity connects
    /// </summary>
    [Serializable]
    public class UnityRegisterParams
    {
        public string projectPath;
        public string unityVersion;
    }
    
    /// <summary>
    /// Operation result sent when an operation completes
    /// </summary>
    [Serializable]
    public class OperationResult
    {
        public string operationId;
        public bool success;
        public string error;
        public object data;
    }
    
    #endregion
    
    #region Test Result Types
    
    /// <summary>
    /// Individual test result
    /// </summary>
    [Serializable]
    public class TestResultInfo
    {
        public string testName;
        public string className;
        public bool passed;
        public float duration;
        public string message;
        public string stackTrace;
    }
    
    /// <summary>
    /// Aggregated test run results
    /// </summary>
    [Serializable]
    public class TestRunResult
    {
        public int passed;
        public int failed;
        public int skipped;
        public float totalDuration;
        public List<TestResultInfo> failures;
        public List<TestResultInfo> allResults;
    }
    
    #endregion
    
    #region Command Types
    
    /// <summary>
    /// Commands that Unity can receive from daemon
    /// </summary>
    public static class UnityDirectCommands
    {
        public const string Register = "unity.register";
        public const string GetState = "unity.direct.getState";
        public const string EnterPlayMode = "unity.direct.enterPlayMode";
        public const string ExitPlayMode = "unity.direct.exitPlayMode";
        public const string LoadScene = "unity.direct.loadScene";
        public const string CreateScene = "unity.direct.createScene";
        public const string RunTests = "unity.direct.runTests";
        public const string Compile = "unity.direct.compile";
        public const string FocusEditor = "unity.direct.focusEditor";
        public const string GetConsole = "unity.direct.getConsole";
    }
    
    /// <summary>
    /// Events that Unity sends to daemon
    /// </summary>
    public static class UnityEvents
    {
        public const string StateChanged = "unity.stateChanged";
        public const string OperationComplete = "unity.operationComplete";
        public const string CompileStarted = "unity.compileStarted";
        public const string CompileComplete = "unity.compileComplete";
        public const string PlayModeChanged = "unity.playModeChanged";
        public const string TestProgress = "unity.testProgress";
        public const string TestComplete = "unity.testComplete";
        public const string Error = "unity.error";
    }
    
    #endregion
    
    #region JSON Helpers
    
    /// <summary>
    /// JSON serialization helpers using Unity's JsonUtility with fallbacks
    /// </summary>
    public static class JsonHelper
    {
        public static string ToJson(object obj)
        {
            try
            {
                return JsonUtility.ToJson(obj);
            }
            catch
            {
                // Fallback for dictionaries and complex types
                return SimpleJsonSerialize(obj);
            }
        }
        
        public static T FromJson<T>(string json)
        {
            return JsonUtility.FromJson<T>(json);
        }
        
        /// <summary>
        /// Simple JSON serializer for Dictionary types
        /// </summary>
        private static string SimpleJsonSerialize(object obj)
        {
            if (obj == null) return "null";
            
            if (obj is string s)
                return $"\"{EscapeString(s)}\"";
            
            if (obj is bool b)
                return b ? "true" : "false";
            
            if (obj is int || obj is long || obj is float || obj is double)
                return obj.ToString();
            
            // Use non-generic IDictionary for better compatibility with Unity's Mono runtime
            // The generic IDictionary<string, object> pattern matching may fail when object is boxed
            if (obj is IDictionary dict)
            {
                var parts = new List<string>();
                foreach (DictionaryEntry kvp in dict)
                {
                    string key = kvp.Key?.ToString() ?? "";
                    parts.Add($"\"{EscapeString(key)}\":{SimpleJsonSerialize(kvp.Value)}");
                }
                return "{" + string.Join(",", parts) + "}";
            }
            
            // Handle generic lists/enumerables
            if (obj is IEnumerable enumerable && !(obj is string))
            {
                var parts = new List<string>();
                foreach (var item in enumerable)
                {
                    parts.Add(SimpleJsonSerialize(item));
                }
                return "[" + string.Join(",", parts) + "]";
            }
            
            // Fall back to JsonUtility for other types
            return JsonUtility.ToJson(obj);
        }
        
        private static string EscapeString(string s)
        {
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }
        
        /// <summary>
        /// Create a WebSocket message wrapper
        /// </summary>
        public static string CreateRequestMessage(ApcRequest request)
        {
            // Manually serialize ApcRequest because JsonUtility doesn't support Dictionary
            var parts = new List<string>();
            parts.Add($"\"id\":\"{EscapeString(request.id)}\"");
            parts.Add($"\"cmd\":\"{EscapeString(request.cmd)}\"");
            
            // Serialize params dictionary
            if (request.@params != null && request.@params.Count > 0)
            {
                parts.Add($"\"params\":{SimpleJsonSerialize(request.@params)}");
            }
            else
            {
                parts.Add("\"params\":{}");
            }
            
            // Add clientId if present
            if (!string.IsNullOrEmpty(request.clientId))
            {
                parts.Add($"\"clientId\":\"{EscapeString(request.clientId)}\"");
            }
            
            var payload = "{" + string.Join(",", parts) + "}";
            return $"{{\"type\":\"request\",\"payload\":{payload}}}";
        }
        
        /// <summary>
        /// Create an event message to send to daemon
        /// </summary>
        public static string CreateEventMessage(string eventName, object data)
        {
            var timestamp = DateTime.UtcNow.ToString("o");
            return $"{{\"type\":\"event\",\"payload\":{{\"event\":\"{eventName}\",\"data\":{ToJson(data)},\"timestamp\":\"{timestamp}\"}}}}";
        }
        
        /// <summary>
        /// Create a response message to send back to daemon
        /// </summary>
        public static string CreateResponseMessage(ApcResponse response)
        {
            var parts = new System.Collections.Generic.List<string>();
            parts.Add($"\"id\":\"{EscapeString(response.id)}\"");
            parts.Add($"\"success\":{(response.success ? "true" : "false")}");
            
            if (!string.IsNullOrEmpty(response.error))
            {
                parts.Add($"\"error\":\"{EscapeString(response.error)}\"");
            }
            
            if (response.data != null)
            {
                parts.Add($"\"data\":{ToJson(response.data)}");
            }
            
            var payload = "{" + string.Join(",", parts) + "}";
            return $"{{\"type\":\"response\",\"payload\":{payload}}}";
        }
    }
    
    #endregion
}

