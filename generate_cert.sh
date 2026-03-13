#!/bin/bash
# Generate self-signed SSL certificate for local HTTPS server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$SCRIPT_DIR/server/ssl"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

echo ""
echo "🔐 Generating SSL Certificate for Jakeraoke"
echo "=========================================="
echo ""

# Create ssl directory if it doesn't exist
mkdir -p "$CERT_DIR"

# Check if certificate already exists
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    echo "⚠️  SSL certificate already exists:"
    echo "   $CERT_FILE"
    echo "   $KEY_FILE"
    echo ""
    read -p "Regenerate? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing certificate."
        exit 0
    fi
fi

# Get network IP for certificate
echo "Detecting network IP addresses..."
IPS=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}')
echo "Found IPs:"
echo "$IPS" | while read ip; do echo "  - $ip"; done
echo ""

# Generate self-signed certificate (valid for 10 years)
echo "Generating certificate..."
openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -days 3650 \
    -subj "/CN=jakeraoke.local/O=Jakeraoke/C=US" \
    -addext "subjectAltName=DNS:localhost,DNS:jakeraoke.local,IP:127.0.0.1$(echo "$IPS" | while read ip; do echo -n ",IP:$ip"; done)" \
    2>/dev/null

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SSL Certificate generated successfully!"
    echo ""
    echo "Certificate: $CERT_FILE"
    echo "Private Key: $KEY_FILE"
    echo ""
    echo "📱 Band Member Setup:"
    echo "   1. Open browser on phone/tablet"
    echo "   2. Go to: https://YOUR-MACBOOK-IP:9898/"
    echo "   3. Browser shows 'Not Secure' warning"
    echo "   4. Click 'Advanced' → 'Proceed to site' (wording varies)"
    echo "   5. Accept certificate (one-time per device)"
    echo "   6. Done! Bookmark the URL for easy access"
    echo ""
else
    echo ""
    echo "❌ Certificate generation failed!"
    echo "Make sure OpenSSL is installed: brew install openssl"
    exit 1
fi
