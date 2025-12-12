using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace ApcBridge
{
    /// <summary>
    /// Handles Unity Test Runner operations for EditMode and PlayMode tests.
    /// Uses Unity's TestRunnerApi for test execution.
    /// </summary>
    public static class TestController
    {
        #region Test Execution
        
        /// <summary>
        /// Run tests with the specified mode
        /// </summary>
        /// <param name="mode">"EditMode" or "PlayMode"</param>
        /// <param name="filter">Optional test name filters</param>
        public static async Task<ApcResponse> RunTestsAsync(string mode, string[] filter = null)
        {
            if (!StateManager.Instance.IsReady)
            {
                return new ApcResponse
                {
                    success = false,
                    error = $"Unity is busy: {StateManager.Instance.CurrentOperation ?? "compiling"}"
                };
            }
            
            var testMode = mode.ToLower() == "playmode" ? TestMode.PlayMode : TestMode.EditMode;
            var opId = StateManager.Instance.StartOperation($"runTests_{mode}");
            
            if (opId == null)
            {
                return new ApcResponse { success = false, error = "Failed to start operation" };
            }
            
            try
            {
                var testRunner = ScriptableObject.CreateInstance<TestRunnerApi>();
                var resultCollector = new TestResultCollector();
                
                testRunner.RegisterCallbacks(resultCollector);
                
                // Build filter
                var testFilter = new Filter
                {
                    testMode = testMode
                };
                
                if (filter != null && filter.Length > 0)
                {
                    testFilter.testNames = filter;
                }
                
                // Execute tests
                testRunner.Execute(new ExecutionSettings(testFilter));
                
                // Wait for completion
                var startTime = DateTime.Now;
                int timeoutMs = testMode == TestMode.PlayMode ? 600000 : 300000; // 10 min / 5 min
                
                while (!resultCollector.IsComplete)
                {
                    if ((DateTime.Now - startTime).TotalMilliseconds > timeoutMs)
                    {
                        StateManager.Instance.CompleteOperation(opId, false);
                        return new ApcResponse
                        {
                            success = false,
                            error = "Test run timed out"
                        };
                    }
                    await Task.Delay(500);
                }
                
                // Unregister callbacks
                testRunner.UnregisterCallbacks(resultCollector);
                
                var result = resultCollector.GetResult();
                bool success = result.failed == 0;
                
                StateManager.Instance.CompleteOperation(opId, success);
                
                // Notify daemon of test completion
                ApcUnityBridge.Instance?.SendEvent(UnityEvents.TestComplete, new
                {
                    operationId = opId,
                    mode,
                    passed = result.passed,
                    failed = result.failed,
                    skipped = result.skipped,
                    duration = result.totalDuration,
                    failures = result.failures?.Select(f => new
                    {
                        testName = f.testName,
                        message = f.message
                    }).ToArray()
                });
                
                return new ApcResponse
                {
                    success = success,
                    data = result
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
        
        #region Test Result Collector
        
        /// <summary>
        /// Collects test results from the TestRunner API
        /// </summary>
        private class TestResultCollector : ICallbacks
        {
            private readonly List<TestResultInfo> _allResults = new List<TestResultInfo>();
            private readonly List<TestResultInfo> _failures = new List<TestResultInfo>();
            private bool _isComplete = false;
            private float _totalDuration = 0;
            
            public bool IsComplete => _isComplete;
            
            public TestRunResult GetResult()
            {
                return new TestRunResult
                {
                    passed = _allResults.Count(r => r.passed),
                    failed = _failures.Count,
                    skipped = _allResults.Count(r => !r.passed && string.IsNullOrEmpty(r.message)),
                    totalDuration = _totalDuration,
                    failures = _failures,
                    allResults = _allResults
                };
            }
            
            public void RunStarted(ITestAdaptor testsToRun)
            {
                _allResults.Clear();
                _failures.Clear();
                _isComplete = false;
                _totalDuration = 0;
                
                Debug.Log($"[APC] Test run started: {testsToRun.Name}");
                
                // Notify daemon
                ApcUnityBridge.Instance?.SendEvent(UnityEvents.TestProgress, new
                {
                    phase = "started",
                    testCount = CountTests(testsToRun)
                });
            }
            
            public void RunFinished(ITestResultAdaptor result)
            {
                _totalDuration = (float)result.Duration;
                _isComplete = true;
                
                Debug.Log($"[APC] Test run finished: {result.PassCount} passed, {result.FailCount} failed");
            }
            
            public void TestStarted(ITestAdaptor test)
            {
                // Individual test started
            }
            
            public void TestFinished(ITestResultAdaptor result)
            {
                if (!result.HasChildren)
                {
                    var testResult = new TestResultInfo
                    {
                        testName = result.Name,
                        className = result.FullName.Contains(".") 
                            ? result.FullName.Substring(0, result.FullName.LastIndexOf('.'))
                            : "",
                        passed = result.TestStatus == TestStatus.Passed,
                        duration = (float)result.Duration,
                        message = result.Message,
                        stackTrace = result.StackTrace
                    };
                    
                    _allResults.Add(testResult);
                    
                    if (result.TestStatus == TestStatus.Failed)
                    {
                        _failures.Add(testResult);
                        Debug.LogWarning($"[APC] Test failed: {result.Name} - {result.Message}");
                    }
                }
            }
            
            private int CountTests(ITestAdaptor test)
            {
                if (!test.HasChildren)
                {
                    return test.IsSuite ? 0 : 1;
                }
                
                int count = 0;
                foreach (var child in test.Children)
                {
                    count += CountTests(child);
                }
                return count;
            }
        }
        
        #endregion
    }
}

