
import { ElodinClient, ElodinPacketType } from './src/elodin-client.js';

async function testMassiveSub() {
  const client = new ElodinClient('127.0.0.1', 2240);

  console.log('Connecting...');
  if (!await client.connect()) {
    console.error('Failed to connect');
    return;
  }

  let packets = 0;
  client.on('packet', (header) => {
    if (header.ty === ElodinPacketType.TABLE) {
      packets++;
    }
  });

  const vtableStreamMsgId = [0x11, 0x0d]; // VTableStream
  
  console.log('Sending 300 subscriptions...');
  for (let i = 1; i <= 300; i++) {
    const high = 0x20; // PT
    const low = i % 256; 
    const payload = Buffer.from([high, low]);
    client.sendRawMessage(vtableStreamMsgId, ElodinPacketType.MSG, payload);
  }

  await new Promise(r => setTimeout(r, 1000));

  console.log('Publishing to [0x20, 0x01]...');
  const packetId = [0x20, 0x01];
  const payload = Buffer.alloc(21, 0); 
  payload.writeBigUInt64LE(BigInt(Date.now()), 0);
  payload.writeUInt32LE(9999, 12);
  
  client.publishTable(packetId, payload);

  console.log('Waiting for data...');
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    console.log(`Packets received: ${packets}`);
    if (packets > 0) break;
  }

  client.disconnect();
}

testMassiveSub();
