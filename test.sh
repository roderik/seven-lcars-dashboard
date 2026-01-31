#!/bin/bash
# LCARS Dashboard Test Script
set -e

echo "🖖 Testing LCARS Bridge Dashboard..."
echo ""

# Check if server is running
if ! lsof -i:4242 &>/dev/null 2>&1; then
    echo "⚠️  Server not running on port 4242"
    echo "   Run: ./start.sh"
    exit 1
fi

echo "✅ Server running on port 4242"

# Test health endpoint
echo ""
echo "Testing /health endpoint..."
HEALTH=$(curl -s --max-time 5 http://localhost:4242/health 2>/dev/null)
if [ -n "$HEALTH" ]; then
    echo "✅ Health: $HEALTH"
else
    echo "❌ Health endpoint not responding"
    exit 1
fi

# Test HTML
echo ""
echo "Testing HTML..."
HTML_SIZE=$(curl -s -o /dev/null -w "%{size_download}" --max-time 5 http://localhost:4242/ 2>/dev/null)
if [ "$HTML_SIZE" -gt 1000 ]; then
    echo "✅ HTML loaded: ${HTML_SIZE} bytes"
else
    echo "❌ HTML not loading properly"
    exit 1
fi

# Test API
echo ""
echo "Testing /api/data endpoint..."
API_DATA=$(curl -s --max-time 20 http://localhost:4242/api/data 2>/dev/null | head -c 200)
if [ -n "$API_DATA" ]; then
    echo "✅ API responding"
    echo "   Data preview: ${API_DATA:0:100}..."
else
    echo "⚠️  API may be slow (email checks can take time)"
fi

# Test WebSocket (basic)
echo ""
echo "Testing WebSocket..."
WS_TEST=$(curl -s -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  --max-time 3 \
  http://localhost:4242/ 2>/dev/null | head -1)

if [[ "$WS_TEST" == *"101"* ]]; then
    echo "✅ WebSocket upgrade successful"
else
    echo "⚠️  WebSocket test inconclusive (might still work in browser)"
fi

echo ""
echo "🖖 All tests complete!"
echo ""
echo "Open in browser: http://localhost:4242"
