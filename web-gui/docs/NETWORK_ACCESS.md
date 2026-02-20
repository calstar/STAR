# Network Access Configuration

## Overview
Configure the web GUI to allow external connections from other devices on the network.

## Backend Configuration

### WebSocket Server
The backend WebSocket server is configured to listen on `0.0.0.0` by default, allowing external connections.

**Environment Variables:**
```bash
WS_HOST=0.0.0.0        # Listen on all interfaces
WS_PORT=8081           # WebSocket port
ELODIN_HOST=127.0.0.1  # Elodin DB (local only)
ELODIN_PORT=2240       # Elodin DB port
```

### Firewall Configuration

**Linux (ufw):**
```bash
sudo ufw allow 8081/tcp
sudo ufw allow 3000/tcp
```

**Linux (firewalld):**
```bash
sudo firewall-cmd --add-port=8081/tcp --permanent
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

**macOS:**
- System Preferences → Security & Privacy → Firewall
- Add Node.js and Next.js to allowed applications

**Windows:**
- Windows Defender Firewall → Allow an app
- Add Node.js and Next.js

## Frontend Configuration

### WebSocket URL Detection

The frontend automatically detects the WebSocket URL:

1. **Development**: Uses `ws://localhost:8081` (or `NEXT_PUBLIC_WS_URL`)
2. **Production**: Uses `ws://<current-hostname>:8081`
3. **Manual Override**: User can set custom URL in settings

### Environment Variables

**`.env.local` (development):**
```bash
NEXT_PUBLIC_WS_URL=ws://localhost:8081
```

**Production:**
```bash
NEXT_PUBLIC_WS_URL=ws://<server-ip>:8081
```

### Dynamic URL Detection

```typescript
// Auto-detect WebSocket URL based on current hostname
function getWebSocketUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${hostname}:8081`;
  }
  return process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8081';
}
```

## Accessing from Other Devices

### Find Server IP Address

**Linux/macOS:**
```bash
ip addr show | grep "inet " | grep -v 127.0.0.1
# or
hostname -I
```

**Windows:**
```bash
ipconfig | findstr IPv4
```

### Connect from Mobile/Tablet

1. Ensure server and client are on the same network
2. Open browser on mobile device
3. Navigate to: `http://<server-ip>:3000`
4. WebSocket will automatically connect to `<server-ip>:8081`

### Connect from Another Computer

1. Ensure both devices are on the same network
2. Open browser on remote computer
3. Navigate to: `http://<server-ip>:3000`
4. WebSocket will automatically connect

## Security Considerations

### Development (Local Network)
- Only accessible on local network
- No authentication required
- Suitable for testing and development

### Production (Internet Access)
- **HTTPS/WSS Required**: Use reverse proxy (nginx) with SSL
- **Authentication**: Implement login system
- **Rate Limiting**: Prevent abuse
- **CORS**: Configure properly
- **Firewall**: Only expose necessary ports

### Recommended Setup for Production

**Nginx Reverse Proxy:**
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /ws {
        proxy_pass http://localhost:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Testing Network Access

### From Same Machine
```bash
curl http://localhost:3000
```

### From Another Device
```bash
# Replace <server-ip> with actual IP
curl http://<server-ip>:3000
```

### WebSocket Connection Test
```javascript
// In browser console on remote device
const ws = new WebSocket('ws://<server-ip>:8081');
ws.onopen = () => console.log('Connected!');
ws.onerror = (e) => console.error('Error:', e);
```

## Troubleshooting

### Connection Refused
- Check firewall settings
- Verify server is listening on `0.0.0.0`
- Check network connectivity

### WebSocket Connection Fails
- Verify port 8081 is open
- Check WebSocket URL is correct
- Ensure both devices on same network

### CORS Errors
- Configure CORS in Next.js config
- Check browser console for errors
- Verify headers are set correctly

## Quick Start for Network Access

1. **Start the system:**
   ```bash
   ./scripts/startup/start_tmux.sh
   ```

2. **Find your IP:**
   ```bash
   hostname -I  # Linux
   ipconfig getifaddr en0  # macOS
   ```

3. **Open on mobile/remote device:**
   ```
   http://<your-ip>:3000
   ```

4. **WebSocket will auto-connect** to `<your-ip>:8081`

## Notes

- Backend listens on `0.0.0.0:8081` by default (allows external connections)
- Frontend Next.js dev server listens on `0.0.0.0:3000` by default
- For production, use a reverse proxy with SSL
- Always use WSS (secure WebSocket) over the internet



