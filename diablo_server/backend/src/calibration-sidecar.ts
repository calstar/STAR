import axios from 'axios';
import { WebSocket } from 'ws';
import { readConfig } from './routes/config.js';
import { EventEmitter } from 'events';

export class CalibrationSidecarClient extends EventEmitter {
    private config: any;
    private httpUrl: string;
    private wsUrl: string;
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    public enabled: boolean = false;
    public isConnected: boolean = false;

    constructor() {
        super();
        this.config = readConfig();
        const sidecarCfg = this.config.calibration?.sidecar;
        // Replay mode: no calibration server running; skip sidecar to avoid ECONNREFUSED spam
        this.enabled = (process.env.REPLAY_MODE !== '1' && process.env.REPLAY_MODE !== 'true') && (sidecarCfg?.enabled || false);

        const host = sidecarCfg?.host || '127.0.0.1';
        const port = sidecarCfg?.port || 8100;
        this.httpUrl = `http://${host}:${port}`;
        this.wsUrl = `ws://${host}:${port + 1}`;
    }

    start() {
        if (!this.enabled) return;
        this.connectWs();
    }

    private connectWs() {
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (e) { }
        }

        console.log(`[Sidecar] Connecting to WebSocket at ${this.wsUrl}`);
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
            console.log('[Sidecar] WebSocket connected');
            this.isConnected = true;
            this.emit('connected');
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.emit('message', msg);
            } catch (e) {
                console.error('[Sidecar] WebSocket JSON parse error:', e);
            }
        });

        this.ws.on('close', () => {
            console.log('[Sidecar] WebSocket disconnected');
            this.isConnected = false;
            this.emit('disconnected');
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error('[Sidecar] WebSocket error:', err);
            // 'close' event will trigger reconnect
        });
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const interval = this.config.calibration?.sidecar?.reconnect_interval_ms || 5000;
        this.reconnectTimer = setTimeout(() => this.connectWs(), interval);
    }

    async getStatus() {
        if (!this.enabled || !this.isConnected) return null;
        try {
            const res = await axios.get(`${this.httpUrl}/api/status`, { timeout: 2000 });
            return res.data;
        } catch (e: any) {
            console.error('[Sidecar] Error fetching status:', e.message);
            return null;
        }
    }

    async sendAdcSamples(samples: { channel: number; adc: number }[]) {
        if (!this.enabled || !this.isConnected || samples.length === 0) return;
        try {
            await axios.post(`${this.httpUrl}/api/adc_sample`, { samples }, { timeout: 1000 });
        } catch (e) {
            // Don't log on every sample batch to prevent spam
        }
    }

    async calibrateChannel(channel: number, adcCode: number, referencePsi: number) {
        if (!this.enabled || !this.isConnected) return false;
        try {
            const res = await axios.post(`${this.httpUrl}/api/calibrate`, {
                channel,
                adc_code: adcCode,
                reference_psi: referencePsi
            }, { timeout: 5000 });
            return res.data?.success || false;
        } catch (e: any) {
            console.error(`[Sidecar] Error calibrating channel ${channel}:`, e.message);
            return false;
        }
    }

    async zeroAll(channels: { id: number; adc_code: number }[]) {
        if (!this.enabled || !this.isConnected) return false;
        try {
            const res = await axios.post(`${this.httpUrl}/api/zero_all`, { channels }, { timeout: 5000 });
            return res.data?.success || false;
        } catch (e: any) {
            console.error('[Sidecar] Error zeroing all:', e.message);
            return false;
        }
    }

    async updateEnvironmental(env: any) {
        if (!this.enabled || !this.isConnected) return false;
        try {
            const res = await axios.post(`${this.httpUrl}/api/environmental`, env, { timeout: 5000 });
            return res.data?.success || false;
        } catch (e: any) {
            console.error('[Sidecar] Error updating environmental:', e.message);
            return false;
        }
    }

    async getEnvironmental() {
        if (!this.enabled || !this.isConnected) return null;
        try {
            const res = await axios.get(`${this.httpUrl}/api/environmental`, { timeout: 2000 });
            return res.data;
        } catch (e: any) {
            console.error('[Sidecar] Error fetching environmental:', e.message);
            return null;
        }
    }
}
