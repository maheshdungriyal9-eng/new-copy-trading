const { Client } = require('ssh2');
const net = require('net');

class TunnelService {
  constructor() {
    this.sshConfig = {
      host: '34.93.162.96',
      port: 22,
      username: 'tradenterinvest',
      password: 'mahesh789',
      readyTimeout: 30000
    };
    this.localPort = 3128;
    this.remoteHost = '127.0.0.1';
    this.remotePort = 3128;
    this.conn = null;
    this.server = null;
    this.isConnected = false;
  }

  async startTunnel() {
    return new Promise((resolve) => {
      console.log('[TunnelService] Initializing SSH tunnel to VPS...');
      this.conn = new Client();

      this.conn.on('ready', () => {
        console.log('[TunnelService] SSH Connection established.');
        
        // Start TCP forwarding server
        this.server = net.createServer((socket) => {
          if (!this.isConnected) {
            console.log('[TunnelService] Forwarding requested, but SSH is disconnected.');
            socket.destroy();
            return;
          }

          this.conn.forwardOut('127.0.0.1', socket.remotePort, this.remoteHost, this.remotePort, (err, stream) => {
            if (err) {
              console.error('[TunnelService] ForwardOut error:', err.message);
              socket.destroy();
              return;
            }
            
            socket.pipe(stream).pipe(socket);
            
            socket.on('error', (err) => {
              stream.destroy();
            });
            
            stream.on('error', (err) => {
              socket.destroy();
            });
          });
        });

        // Close any existing server on this port first
        this.server.on('error', (err) => {
          console.error('[TunnelService] Local forwarding server error:', err.message);
          if (err.code === 'EADDRINUSE') {
            console.log(`[TunnelService] Port ${this.localPort} in use, retrying in 5s...`);
            setTimeout(() => {
              this.server.close();
              this.server.listen(this.localPort, '127.0.0.1');
            }, 5000);
          }
        });

        this.server.listen(this.localPort, '127.0.0.1', () => {
          console.log(`[TunnelService] SSH Tunnel Server listening on 127.0.0.1:${this.localPort}`);
          this.isConnected = true;
          resolve(true);
        });
      });

      this.conn.on('error', (err) => {
        console.error('[TunnelService] SSH Connection error:', err.message);
        this.isConnected = false;
        resolve(false);
      });

      this.conn.on('end', () => {
        console.log('[TunnelService] SSH Connection ended.');
        this.isConnected = false;
        this.reconnect();
      });

      this.conn.on('close', () => {
        console.log('[TunnelService] SSH Connection closed.');
        this.isConnected = false;
        this.reconnect();
      });

      try {
        this.conn.connect(this.sshConfig);
      } catch (e) {
        console.error('[TunnelService] SSH connect exception:', e.message);
        resolve(false);
      }
    });
  }

  reconnect() {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {}
    }
    console.log('[TunnelService] Reconnecting SSH tunnel in 10 seconds...');
    setTimeout(() => {
      this.startTunnel();
    }, 10000);
  }
}

module.exports = new TunnelService();
