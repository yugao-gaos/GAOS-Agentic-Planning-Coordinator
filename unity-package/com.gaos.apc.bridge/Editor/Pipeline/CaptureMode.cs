namespace ApcBridge.Pipeline
{
    /// <summary>
    /// Capture mode for pipeline steps
    /// </summary>
    public enum CaptureMode
    {
        /// <summary>
        /// Capture log at end only (for prep step)
        /// </summary>
        LogAtEnd,
        
        /// <summary>
        /// Continuous log capture at 10x/sec (for test_editmode)
        /// </summary>
        LogContinuous,
        
        /// <summary>
        /// Continuous log + screenshot buffer (for test_playmode, test_player)
        /// </summary>
        LogAndScreenshot
    }
    
    /// <summary>
    /// Pipeline operation types
    /// </summary>
    public enum PipelineOperation
    {
        Prep,
        TestEditMode,
        TestPlayMode,
        TestPlayer
    }
    
    /// <summary>
    /// Result of a single pipeline step
    /// </summary>
    public class StepResult
    {
        public string Operation { get; set; }
        public bool Success { get; set; }
        public string LogPath { get; set; }
        public int ErrorCount { get; set; }
        public int WarningCount { get; set; }
        public string Error { get; set; }
    }
    
    /// <summary>
    /// Result of entire pipeline execution
    /// </summary>
    public class PipelineResult
    {
        public bool Success { get; set; }
        public string FailedAtStep { get; set; }
        public string LogFolder { get; set; }
        public StepResult[] StepResults { get; set; }
    }
}

