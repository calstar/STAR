// Diagnostic script to verify multiple concurrent subscriptions to Elodin DB.
// Usage: node scripts/debug/test_vtable_subscription.js [elodin_host] [elodin_port]

const { ElodinClient, ElodinPacketType } = require('../../web-gui/backend/src/elodin-client.js');

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '2240', 10);

const client = new ElodinClient(host, port);

client.on('packet', (header, payload) => {
  console.log(`[Test] Received packet: type=${header.ty}, id=[0x${header.packetId[0].toString(16)}, 0x${header.packetId[1].toString(16)}], len=${header.len}`);
});

async function run() {
  console.log(`[Test] Connecting to Elodin DB at ${host}:${port}...`);
  const connected = await client.connect();
  if (!connected) {
    console.error('[Test] Connection failed');
    process.exit(1);
  }
  console.log('[Test] Connected');

  // Subscribe to PT Raw CH1 (0x20, 0x01)
  const vtableStreamId = [0x11, 0x0d]; // VTableStream
  const payload = Buffer.from([0x20, 0x01]);
  
  console.log('[Test] Subscribing to PT Raw CH1...');
  client.publishTable(vtableStreamId, payload);
  
  console.log('[Test] Waiting for data (Ctrl+C to stop)...');
}

run().catch(console.error);
