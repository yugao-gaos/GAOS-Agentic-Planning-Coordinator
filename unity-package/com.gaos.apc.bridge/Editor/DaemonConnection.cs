using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace ApcBridge
{
    /// <summary>
    /// Connection status for the daemon WebSocket
    /// </summary>
    public enum ConnectionStatus
    {
        Disconnected,
        Connecting,
        Connected,
        Busy,
        Error
    }

    /// <summary>
    /// Manages WebSocket connection to APC Daemon with auto-reconnect.
    /// Handles message sending/receiving and connection lifecycle.
    /// </summary>
    public class DaemonConnection : IDisposable
    {
        #region Constants
        
        private const int DEFAULT_PORT = 19840;
        private const int RECONNECT_INTERVAL_MS = 10000; // 10 seconds
        private const int RECEIVE_BUFFER_SIZE = 8192;
        private const int SEND_TIMEOUT_MS = 5000;
        private const int CONNECT_TIMEOUT_MS = 5000;
        
        #endregion
        
        #region Events
        
        public event Action<ConnectionStatus> OnStatusChanged;
        public event Action<string> OnMessageReceived;
        public event Action<ApcResponse> OnResponseReceived;
        public event Action<ApcEvent> OnEventReceived;
        public event Action<string> OnError;
        
        #endregion
        
        #region State
        
        private ClientWebSocket _webSocket;
        private CancellationTokenSource _cancellationSource;
        private ConnectionStatus _status = ConnectionStatus.Disconnected;
        private string _daemonUrl;
        private int _port;
        private bool _autoReconnect = true;
        private bool _isDisposed = false;
        private DateTime _lastConnectAttempt = DateTime.MinValue;
        
        // Pending requests waiting for responses
        private readonly ConcurrentDictionary<string, TaskCompletionSource<ApcResponse>> _pendingRequests 
            = new ConcurrentDictionary<string, TaskCompletionSource<ApcResponse>>();
        
        // Message queue for thread-safe sending
        private readonly ConcurrentQueue<string> _sendQueue = new ConcurrentQueue<string>();
        
        #endregion
        
        #region Properties
        
        public ConnectionStatus Status
        {
            get => _status;
            private set
            {
                if (_status != value)
                {
                    _status = value;
                    // Invoke on main thread
                    EditorApplication.delayCall += () => OnStatusChanged?.Invoke(value);
                }
            }
        }
        
        public bool IsConnected => _webSocket?.State == WebSocketState.Open;
        public int Port => _port;
        public bool AutoReconnect
        {
            get => _autoReconnect;
            set => _autoReconnect = value;
        }
        
        #endregion
        
        #region Constructor
        
        public DaemonConnection()
        {
            _port = DEFAULT_PORT;
            UpdateDaemonUrl();
        }
        
        #endregion
        
        #region Public Methods
        
        /// <summary>
        /// Set the daemon port
        /// </summary>
        public void SetPort(int port)
        {
            _port = port;
            UpdateDaemonUrl();
        }
        
        /// <summary>
        /// Try to discover daemon port from temp file
        /// </summary>
        public bool TryDiscoverPort()
        {
            try
            {
                string projectPath = Path.GetDirectoryName(Application.dataPath);
                string hash = CreateWorkspaceHash(projectPath);
                string portFilePath = Path.Combine(Path.GetTempPath(), $"apc_daemon_{hash}.port");
                
                if (File.Exists(portFilePath))
                {
                    string portStr = File.ReadAllText(portFilePath).Trim();
                    if (int.TryParse(portStr, out int port))
                    {
                        _port = port;
                        UpdateDaemonUrl();
                        Debug.Log($"[APC] Discovered daemon port: {port}");
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] Failed to discover daemon port: {ex.Message}");
            }
            
            return false;
        }
        
        /// <summary>
        /// Connect to the daemon
        /// </summary>
        public async Task<bool> ConnectAsync()
        {
            if (_isDisposed) return false;
            if (IsConnected) return true;
            
            // Rate limit connection attempts
            if ((DateTime.Now - _lastConnectAttempt).TotalMilliseconds < 2000)
            {
                return false;
            }
            _lastConnectAttempt = DateTime.Now;
            
            Status = ConnectionStatus.Connecting;
            
            try
            {
                // Try to discover port first
                TryDiscoverPort();
                
                _cancellationSource?.Cancel();
                _cancellationSource = new CancellationTokenSource();
                
                _webSocket?.Dispose();
                _webSocket = new ClientWebSocket();
                _webSocket.Options.SetRequestHeader("x-apc-client-type", "unity");
                
                var connectCts = new CancellationTokenSource(CONNECT_TIMEOUT_MS);
                var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
                    _cancellationSource.Token, connectCts.Token);
                
                await _webSocket.ConnectAsync(new Uri(_daemonUrl), linkedCts.Token);
                
                Status = ConnectionStatus.Connected;
                Debug.Log($"[APC] Connected to daemon at {_daemonUrl}");
                
                // Start receive loop
                _ = ReceiveLoopAsync(_cancellationSource.Token);
                
                // Start send loop
                _ = SendLoopAsync(_cancellationSource.Token);
                
                return true;
            }
            catch (OperationCanceledException)
            {
                Status = ConnectionStatus.Disconnected;
                return false;
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] Connection failed: {ex.Message}");
                Status = ConnectionStatus.Error;
                OnError?.Invoke(ex.Message);
                return false;
            }
        }
        
        /// <summary>
        /// Disconnect from the daemon
        /// </summary>
        public async Task DisconnectAsync()
        {
            _autoReconnect = false;
            await CloseConnectionAsync();
        }
        
        /// <summary>
        /// Send a request and wait for response
        /// </summary>
        public async Task<ApcResponse> SendRequestAsync(ApcRequest request, int timeoutMs = 30000)
        {
            if (!IsConnected)
            {
                return new ApcResponse
                {
                    id = request.id,
                    success = false,
                    error = "Not connected to daemon"
                };
            }
            
            var tcs = new TaskCompletionSource<ApcResponse>();
            _pendingRequests[request.id] = tcs;
            
            try
            {
                string message = JsonHelper.CreateRequestMessage(request);
                _sendQueue.Enqueue(message);
                
                using (var cts = new CancellationTokenSource(timeoutMs))
                {
                    cts.Token.Register(() => tcs.TrySetCanceled());
                    return await tcs.Task;
                }
            }
            catch (OperationCanceledException)
            {
                return new ApcResponse
                {
                    id = request.id,
                    success = false,
                    error = "Request timed out"
                };
            }
            finally
            {
                _pendingRequests.TryRemove(request.id, out _);
            }
        }
        
        /// <summary>
        /// Send an event to the daemon (fire and forget)
        /// </summary>
        public void SendEvent(string eventName, object data)
        {
            if (!IsConnected) return;
            
            string message = JsonHelper.CreateEventMessage(eventName, data);
            _sendQueue.Enqueue(message);
        }
        
        /// <summary>
        /// Send raw message
        /// </summary>
        public void SendRaw(string message)
        {
            if (!IsConnected) return;
            _sendQueue.Enqueue(message);
        }
        
        #endregion
        
        #region Private Methods
        
        private void UpdateDaemonUrl()
        {
            _daemonUrl = $"ws://127.0.0.1:{_port}";
        }
        
        private string CreateWorkspaceHash(string path)
        {
            using (var md5 = System.Security.Cryptography.MD5.Create())
            {
                byte[] inputBytes = Encoding.UTF8.GetBytes(path);
                byte[] hashBytes = md5.ComputeHash(inputBytes);
                return BitConverter.ToString(hashBytes).Replace("-", "").Substring(0, 8).ToLower();
            }
        }
        
        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[RECEIVE_BUFFER_SIZE];
            var messageBuilder = new StringBuilder();
            
            try
            {
                while (!cancellationToken.IsCancellationRequested && IsConnected)
                {
                    var result = await _webSocket.ReceiveAsync(
                        new ArraySegment<byte>(buffer), cancellationToken);
                    
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await CloseConnectionAsync();
                        break;
                    }
                    
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        messageBuilder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                        
                        if (result.EndOfMessage)
                        {
                            string message = messageBuilder.ToString();
                            messageBuilder.Clear();
                            ProcessMessage(message);
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown
            }
            catch (WebSocketException ex)
            {
                Debug.LogWarning($"[APC] WebSocket error: {ex.Message}");
                OnError?.Invoke(ex.Message);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[APC] Receive error: {ex}");
                OnError?.Invoke(ex.Message);
            }
            finally
            {
                await HandleDisconnectAsync();
            }
        }
        
        private async Task SendLoopAsync(CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested && IsConnected)
                {
                    if (_sendQueue.TryDequeue(out string message))
                    {
                        var bytes = Encoding.UTF8.GetBytes(message);
                        var segment = new ArraySegment<byte>(bytes);
                        
                        using (var cts = new CancellationTokenSource(SEND_TIMEOUT_MS))
                        {
                            var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
                                cancellationToken, cts.Token);
                            
                            await _webSocket.SendAsync(segment, WebSocketMessageType.Text, 
                                true, linkedCts.Token);
                        }
                    }
                    else
                    {
                        await Task.Delay(10, cancellationToken);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown
            }
            catch (Exception ex)
            {
                Debug.LogError($"[APC] Send error: {ex}");
            }
        }
        
        private void ProcessMessage(string message)
        {
            try
            {
                // Invoke on main thread
                EditorApplication.delayCall += () =>
                {
                    try
                    {
                        OnMessageReceived?.Invoke(message);
                        
                        // Parse message type
                        if (message.Contains("\"type\":\"response\""))
                        {
                            // Extract the response from the message
                            var response = ParseResponse(message);
                            if (response != null)
                            {
                                OnResponseReceived?.Invoke(response);
                                
                                // Complete pending request
                                if (_pendingRequests.TryRemove(response.id, out var tcs))
                                {
                                    tcs.TrySetResult(response);
                                }
                            }
                        }
                        else if (message.Contains("\"type\":\"event\""))
                        {
                            var evt = ParseEvent(message);
                            if (evt != null)
                            {
                                OnEventReceived?.Invoke(evt);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"[APC] Error processing message: {ex}");
                    }
                };
            }
            catch (Exception ex)
            {
                Debug.LogError($"[APC] ProcessMessage error: {ex}");
            }
        }
        
        private ApcResponse ParseResponse(string message)
        {
            try
            {
                // Simple extraction - find payload and parse
                int payloadStart = message.IndexOf("\"payload\":");
                if (payloadStart >= 0)
                {
                    // Find the response object
                    int objStart = message.IndexOf("{", payloadStart + 10);
                    if (objStart >= 0)
                    {
                        // Count braces to find end
                        int depth = 0;
                        int objEnd = objStart;
                        for (int i = objStart; i < message.Length; i++)
                        {
                            if (message[i] == '{') depth++;
                            else if (message[i] == '}') depth--;
                            
                            if (depth == 0)
                            {
                                objEnd = i;
                                break;
                            }
                        }
                        
                        string responseJson = message.Substring(objStart, objEnd - objStart + 1);
                        return JsonUtility.FromJson<ApcResponse>(responseJson);
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] Failed to parse response: {ex.Message}");
            }
            return null;
        }
        
        private ApcEvent ParseEvent(string message)
        {
            try
            {
                int payloadStart = message.IndexOf("\"payload\":");
                if (payloadStart >= 0)
                {
                    int objStart = message.IndexOf("{", payloadStart + 10);
                    if (objStart >= 0)
                    {
                        int depth = 0;
                        int objEnd = objStart;
                        for (int i = objStart; i < message.Length; i++)
                        {
                            if (message[i] == '{') depth++;
                            else if (message[i] == '}') depth--;
                            
                            if (depth == 0)
                            {
                                objEnd = i;
                                break;
                            }
                        }
                        
                        string eventJson = message.Substring(objStart, objEnd - objStart + 1);
                        return JsonUtility.FromJson<ApcEvent>(eventJson);
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] Failed to parse event: {ex.Message}");
            }
            return null;
        }
        
        private async Task CloseConnectionAsync()
        {
            try
            {
                _cancellationSource?.Cancel();
                
                if (_webSocket?.State == WebSocketState.Open)
                {
                    using (var cts = new CancellationTokenSource(2000))
                    {
                        await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, 
                            "Closing", cts.Token);
                    }
                }
            }
            catch
            {
                // Ignore close errors
            }
            finally
            {
                Status = ConnectionStatus.Disconnected;
            }
        }
        
        private async Task HandleDisconnectAsync()
        {
            Status = ConnectionStatus.Disconnected;
            
            // Cancel all pending requests
            foreach (var kvp in _pendingRequests)
            {
                kvp.Value.TrySetCanceled();
            }
            _pendingRequests.Clear();
            
            // Auto-reconnect if enabled
            if (_autoReconnect && !_isDisposed)
            {
                await Task.Delay(RECONNECT_INTERVAL_MS);
                if (_autoReconnect && !_isDisposed)
                {
                    _ = ConnectAsync();
                }
            }
        }
        
        #endregion
        
        #region IDisposable
        
        public void Dispose()
        {
            if (_isDisposed) return;
            _isDisposed = true;
            
            _autoReconnect = false;
            _cancellationSource?.Cancel();
            _webSocket?.Dispose();
            _cancellationSource?.Dispose();
        }
        
        #endregion
    }
}

