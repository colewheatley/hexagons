from http.server import BaseHTTPRequestHandler, HTTPServer
import os

LOG_FILE = "/Users/cole/dev/PowFinder/frontend/hexagons/app/fuckups.md"

class Logger(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length).decode('utf-8')
        
        mode = 'w' if "--- NEW SESSION ---" in post_data else 'a'
        
        with open(LOG_FILE, mode) as f:
            f.write(post_data + "\n")
            
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def run(port=8888):
    server_address = ('', port)
    httpd = HTTPServer(server_address, Logger)
    print(f"Logger server running on port {port}...")
    httpd.serve_forever()

if __name__ == "__main__":
    run()
