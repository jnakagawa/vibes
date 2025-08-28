#!/usr/bin/env python3
import http.server
import ssl
import socketserver
import os

PORT = 8444
CERT_FILE = "cert.pem"
KEY_FILE = "key.pem"

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add security headers for camera access
        self.send_header('Permissions-Policy', 'camera=(self)')
        self.send_header('Feature-Policy', 'camera *')
        super().end_headers()

    def log_message(self, format, *args):
        # Custom logging
        print(f"{self.address_string()} - {format % args}")

if __name__ == "__main__":
    # Check if certificates exist
    if not os.path.exists(CERT_FILE) or not os.path.exists(KEY_FILE):
        print("SSL certificates not found!")
        exit(1)
    
    # Create HTTPS server
    with socketserver.TCPServer(("", PORT), MyHTTPRequestHandler) as httpd:
        # Wrap with SSL
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(CERT_FILE, KEY_FILE)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        
        print(f"HTTPS Server running on port {PORT}")
        print(f"Access from mobile: https://192.168.1.29:{PORT}/stress_relief_app.html")
        print("Note: You'll need to accept the self-signed certificate warning")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()