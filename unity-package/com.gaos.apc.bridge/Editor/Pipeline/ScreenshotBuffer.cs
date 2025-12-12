using System;
using System.Collections.Generic;
using UnityEngine;

namespace ApcBridge.Pipeline
{
    /// <summary>
    /// Rolling buffer of screenshots for capturing around error times.
    /// Maintains last N frames (typically 2 seconds worth at 10fps).
    /// </summary>
    public class ScreenshotBuffer : IDisposable
    {
        private readonly int _bufferSize;
        private readonly Queue<BufferedFrame> _frames;
        private bool _isDisposed;
        
        private class BufferedFrame
        {
            public DateTime Timestamp { get; set; }
            public Texture2D Texture { get; set; }
        }
        
        /// <summary>
        /// Create a new screenshot buffer
        /// </summary>
        /// <param name="bufferSize">Number of frames to keep (e.g., 20 for 2 seconds at 10fps)</param>
        public ScreenshotBuffer(int bufferSize)
        {
            _bufferSize = bufferSize;
            _frames = new Queue<BufferedFrame>(bufferSize);
        }
        
        /// <summary>
        /// Capture current frame and add to buffer
        /// </summary>
        public void CaptureFrame()
        {
            if (_isDisposed) return;
            
            try
            {
                // Capture screen to texture
                var texture = new Texture2D(Screen.width, Screen.height, TextureFormat.RGB24, false);
                texture.ReadPixels(new Rect(0, 0, Screen.width, Screen.height), 0, 0);
                texture.Apply();
                
                // Add to buffer
                _frames.Enqueue(new BufferedFrame
                {
                    Timestamp = DateTime.Now,
                    Texture = texture
                });
                
                // Remove old frames if over capacity
                while (_frames.Count > _bufferSize)
                {
                    var old = _frames.Dequeue();
                    if (old.Texture != null)
                    {
                        UnityEngine.Object.DestroyImmediate(old.Texture);
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] Screenshot capture failed: {ex.Message}");
            }
        }
        
        /// <summary>
        /// Get screenshots within a time window around a target time
        /// </summary>
        /// <param name="centerTime">The center time (typically error time)</param>
        /// <param name="windowSeconds">Window size in seconds (e.g., 1.0 for +/- 1 second)</param>
        /// <returns>List of (texture, offsetMs) tuples</returns>
        public List<(Texture2D texture, int offsetMs)> GetScreenshotsAround(DateTime centerTime, float windowSeconds)
        {
            var result = new List<(Texture2D texture, int offsetMs)>();
            
            foreach (var frame in _frames)
            {
                var offset = (frame.Timestamp - centerTime).TotalMilliseconds;
                
                // Check if within window
                if (Math.Abs(offset) <= windowSeconds * 1000)
                {
                    // Clone the texture so we can keep it after buffer disposal
                    var clone = CloneTexture(frame.Texture);
                    if (clone != null)
                    {
                        result.Add((clone, (int)offset));
                    }
                }
            }
            
            // Sort by offset
            result.Sort((a, b) => a.offsetMs.CompareTo(b.offsetMs));
            
            return result;
        }
        
        private Texture2D CloneTexture(Texture2D source)
        {
            if (source == null) return null;
            
            try
            {
                var clone = new Texture2D(source.width, source.height, source.format, false);
                clone.SetPixels(source.GetPixels());
                clone.Apply();
                return clone;
            }
            catch
            {
                return null;
            }
        }
        
        /// <summary>
        /// Clear all buffered frames
        /// </summary>
        public void Clear()
        {
            while (_frames.Count > 0)
            {
                var frame = _frames.Dequeue();
                if (frame.Texture != null)
                {
                    UnityEngine.Object.DestroyImmediate(frame.Texture);
                }
            }
        }
        
        public void Dispose()
        {
            if (_isDisposed) return;
            _isDisposed = true;
            Clear();
        }
    }
}

