#!/bin/bash
# oracle-keepalive.sh
# This script compiles and runs lookbusy to generate ~15% CPU load
# to prevent Oracle Cloud from terminating free tier instances due to inactivity

set -e

LOOKBUSY_VERSION="1.4"
LOOKBUSY_URL="http://www.devin.com/lookbusy/lookbusy-${LOOKBUSY_VERSION}.tar.gz"
INSTALL_DIR="/opt/lookbusy"
CPU_LOAD=15

echo "=== Oracle Cloud Keep-Alive Script ==="
echo "Installing lookbusy to generate ${CPU_LOAD}% CPU load..."

# Create install directory
sudo mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

# Download and compile lookbusy if not already installed
if [ ! -f "${INSTALL_DIR}/lookbusy" ]; then
    echo "Downloading lookbusy ${LOOKBUSY_VERSION}..."
    wget -q "${LOOKBUSY_URL}" -O lookbusy.tar.gz
    tar -xzf lookbusy.tar.gz
    cd "lookbusy-${LOOKBUSY_VERSION}"
    ./configure --prefix="${INSTALL_DIR}"
    make -j$(nproc)
    make install
    cd ..
    rm -rf "lookbusy-${LOOKBUSY_VERSION}" lookbusy.tar.gz
else
    echo "lookbusy already installed at ${INSTALL_DIR}/lookbusy"
fi

# Run lookbusy in background
echo "Starting lookbusy with ${CPU_LOAD}% CPU load..."
nohup "${INSTALL_DIR}/bin/lookbusy" -c "${CPU_LOAD}" -r curve > /var/log/lookbusy.log 2>&1 &
LOOKBUSY_PID=$!

echo "lookbusy started with PID: ${LOOKBUSY_PID}"
echo "CPU load: ${CPU_LOAD}%"
echo "Log file: /var/log/lookbusy.log"
echo ""
echo "To stop: kill ${LOOKBUSY_PID}"
echo "To check status: ps aux | grep lookbusy"

# Keep script running (useful for systemd service)
if [[ "${1}" == "--daemon" ]]; then
    wait ${LOOKBUSY_PID}
fi