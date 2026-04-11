const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8081');

let packets = 0;
let firstEntity = null;

ws.on('open', () => {
    console.log('Connected to backend WS');
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'SENSOR_UPDATE') {
        packets++;
        if (!firstEntity) {
            firstEntity = msg.payload.entity;
            console.log('Received first SENSOR_UPDATE for:', firstEntity, 'component:', msg.payload.component);
        }
    } else if (msg.type === 'BOARD_STATUS_UPDATE') {
        // Ignore spam
    } else {
        console.log('Received:', msg.type);
    }
});

setTimeout(() => {
    console.log(`Total SENSOR_UPDATE packets received in 3s: ${packets}`);
    process.exit(0);
}, 3000);
