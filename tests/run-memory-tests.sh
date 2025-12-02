#!/bin/bash
# run-memory-tests.sh - Run memory leak detection tests

set -e

echo "=================================="
echo "Memory Leak Detection Test Suite"
echo "=================================="
echo ""

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

# Check if TypeScript is compiled
if [ ! -d "../out" ]; then
    echo "Compiling TypeScript..."
    cd ..
    npm run compile
    cd tests
fi

# Run with garbage collection exposed for accurate memory testing
echo "Running memory leak tests..."
echo "(Using --expose-gc for accurate memory measurements)"
echo ""

node --expose-gc ../out/tests/memory-leak-tests.js

echo ""
echo "=================================="
echo "Tests complete!"
echo "=================================="

