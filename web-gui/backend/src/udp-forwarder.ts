/**
 * UDP Packet Forwarder
 * Forwards UDP packets from one port to another
 * This allows us to receive packets even if DAQ Bridge is using port 5006
 */

import { createSocket, Socket } from 'dgram';

export class UDPForwarder {
  private receiver: Socket | null = null;
  private sender: Socket | null = null;
  private forwardPort: number;
  private forwardHost: string;

  constructor(forwardHost: string = '127.0.0.1', forwardPort: number = 5007) {
    this.forwardHost = forwardHost;
    this.forwardPort = forwardPort;
  }

  async start(sourcePort: number = 5006): Promise<boolean> {
    try {
      // Create receiver socket (reads from source port)
      this.receiver = createSocket('udp4');
      this.receiver.bind(sourcePort, '0.0.0.0', () => {
        console.log(`✅ UDP forwarder listening on port ${sourcePort}`);
      });

      // Create sender socket (forwards to our backend)
      this.sender = createSocket('udp4');

      this.receiver.on('message', (data: Buffer, rinfo: any) => {
        // Forward packet to our backend
        if (this.sender) {
          this.sender.send(data, this.forwardPort, this.forwardHost, (err) => {
            if (err) {
              console.error('❌ Failed to forward UDP packet:', err);
            }
          });
        }
      });

      return true;
    } catch (error) {
      console.error('❌ Failed to start UDP forwarder:', error);
      return false;
    }
  }

  stop(): void {
    if (this.receiver) {
      this.receiver.close();
      this.receiver = null;
    }
    if (this.sender) {
      this.sender.close();
      this.sender = null;
    }
  }
}
