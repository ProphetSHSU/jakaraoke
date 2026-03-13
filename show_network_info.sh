#!/bin/bash
# Show network information for stage setup

echo ""
echo "🎸 Jakeraoke Network Info"
echo "========================================"
echo ""

# Get IP addresses
echo "📡 Your MacBook's IP addresses:"
echo ""

# Get all network interfaces with IP addresses
ifconfig | grep "inet " | grep -v 127.0.0.1 | while read -r line; do
    ip=$(echo $line | awk '{print $2}')
    echo "   $ip"
done

echo ""
echo "🌐 Stage Access URLs:"
echo ""

# Show URLs for each IP
ifconfig | grep "inet " | grep -v 127.0.0.1 | while read -r line; do
    ip=$(echo $line | awk '{print $2}')
    echo "   Client:       http://$ip:9898/"
    echo "   Test Harness: http://$ip:9898/test_harness.html"
    echo ""
done

echo "========================================"
echo ""
echo "📝 Setup Instructions:"
echo ""
echo "1. Make sure the server is running (./start.sh)"
echo ""
echo "2. Configure macOS Firewall:"
echo "   • Go to System Settings → Network → Firewall"
echo "   • Turn Firewall ON"
echo "   • Click 'Options...'"
echo "   • Click '+' to add an application"
echo "   • Navigate to: /usr/local/bin/node"
echo "   • (or find where Node.js is installed)"
echo "   • Set to 'Allow incoming connections'"
echo ""
echo "   Alternative (command line):"
echo "   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/node"
echo "   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /usr/local/bin/node"
echo ""
echo "3. Give your band members one of the URLs above!"
echo ""
echo "4. Make sure everyone is on the same WiFi network"
echo ""
