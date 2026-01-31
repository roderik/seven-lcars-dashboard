#!/bin/bash
# LCARS Bridge Dashboard - Startup Script
set -e

cd "$(dirname "$0")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
cat << 'EOF'
╔══════════════════════════════════════════════════════════════════╗
║                   🖖 LCARS BRIDGE DASHBOARD 🖖                   ║
╚══════════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Kill any existing dashboard processes
if lsof -i:4242 &>/dev/null 2>&1; then
    echo -e "${YELLOW}Stopping existing server on port 4242...${NC}"
    kill $(lsof -t -i:4242 2>/dev/null) 2>/dev/null || true
    sleep 1
fi

# Check for Node.js
if ! command -v node &>/dev/null; then
    echo -e "${RED}Error: Node.js is required${NC}"
    echo "Install with: sudo apt install nodejs"
    exit 1
fi

# Check dependencies
if [ ! -d "node_modules/ws" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install --production
fi

# Start server
echo -e "${GREEN}Starting LCARS Bridge Dashboard...${NC}"
echo ""

exec node server.js
