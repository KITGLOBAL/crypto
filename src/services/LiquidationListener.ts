// src/services/LiquidationListener.ts

import WebSocket from 'ws';
import { DatabaseService, LiquidationData } from './DatabaseService';
import { TelegramService } from './TelegramService';
import {
    CASCADE_MIN_ORDERS,
    CASCADE_MIN_VOLUME,
    CASCADE_WINDOW_SECONDS,
    CHANNEL_MIN_LIQUIDATION,
    DISBALANCE_MIN_VOLUME,
    DISBALANCE_RATIO,
    DISBALANCE_WINDOW_MINUTES,
    REALTIME_AGGREGATION_WINDOW_SECONDS,
    STORAGE_MIN_LIQUIDATION,
    TELEGRAM_CHANNEL_ID
} from '../config';

type LiquidationSide = 'long' | 'short';

type BufferedLiquidations = {
    symbol: string;
    side: LiquidationSide;
    count: number;
    totalVolume: number;
    totalQuantity: number;
    minPrice: number;
    maxPrice: number;
    firstPrice: number;
    lastPrice: number;
    startTime: number;
    endTime: number;
    timer: NodeJS.Timeout;
};

type ImbalancePoint = {
    time: number;
    longs: number;
    shorts: number;
};

export class LiquidationListener {
    private symbols: string[];
    private dbService: DatabaseService;
    private telegramService: TelegramService;
    private wsBaseUrl: string;
    // Храним массив сокетов, так как теперь их будет несколько (по 1 на пачку символов)
    private activeSockets: WebSocket[] = [];
    private keepAliveIntervals: NodeJS.Timeout[] = [];
    private reconnectTimeouts: NodeJS.Timeout[] = [];
    private aggregationBuffers: Map<string, BufferedLiquidations> = new Map();
    private cascadeBuffers: Map<string, BufferedLiquidations> = new Map();
    private imbalanceWindows: Map<string, ImbalancePoint[]> = new Map();
    private imbalanceAlertCooldowns: Map<string, number> = new Map();
    private imbalanceInterval?: NodeJS.Timeout;
    private isRestarting = false;
    private isStopping = false;
    private messagesReceived = 0;
    private liquidationsProcessed = 0;
    private aggregatesSent = 0;
    private cascadesSent = 0;
    private disbalanceAlertsSent = 0;
    private lastLiquidationAt?: number;

    constructor(symbolsToTrack: string[], dbService: DatabaseService, telegramService: TelegramService, wsBaseUrl: string) {
        this.symbols = symbolsToTrack;
        this.dbService = dbService;
        this.telegramService = telegramService;
        this.wsBaseUrl = wsBaseUrl;
        console.log(`LiquidationListener initialized. Tracking ${this.symbols.length} symbols.`);
    }

    public start(): void {
        if (this.isRestarting) return;
        console.log('🚀 Starting optimized Combined WebSocket listeners...');
        
        // Binance ограничивает длину URL, поэтому разбиваем список символов на чанки (например, по 50)
        const CHUNK_SIZE = 50;
        const chunks = [];
        
        for (let i = 0; i < this.symbols.length; i += CHUNK_SIZE) {
            chunks.push(this.symbols.slice(i, i + CHUNK_SIZE));
        }

        chunks.forEach((chunk, index) => {
            this.connectChunk(chunk, index + 1);
        });

        if (!this.imbalanceInterval) {
            this.imbalanceInterval = setInterval(() => {
                this.checkImbalances().catch(error => {
                    console.error('❌ Error checking liquidation imbalance:', error);
                });
            }, 60_000);
        }
    }

    public async restartConnections(): Promise<void> {
        console.log('♻️ Scheduled WebSocket restart (24h refresh)...');
        this.isRestarting = true;
        this.closeSockets();

        console.log('🔌 All connections closed. Waiting 5 seconds before reconnecting...');
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        this.isRestarting = false;
        this.start();
    }

    public async stop(): Promise<void> {
        this.isStopping = true;
        this.isRestarting = true;
        this.closeSockets();

        if (this.imbalanceInterval) {
            clearInterval(this.imbalanceInterval);
            this.imbalanceInterval = undefined;
        }

        const aggregateKeys = Array.from(this.aggregationBuffers.keys());
        await Promise.all(aggregateKeys.map(key => this.flushAggregate(key)));

        this.cascadeBuffers.forEach(buffer => clearTimeout(buffer.timer));
        this.cascadeBuffers.clear();
        console.log('✅ LiquidationListener stopped.');
    }

    public getStatus() {
        const socketStates = this.activeSockets.reduce<Record<string, number>>((acc, ws) => {
            const stateNames: Record<number, string> = {
                [WebSocket.CONNECTING]: 'CONNECTING',
                [WebSocket.OPEN]: 'OPEN',
                [WebSocket.CLOSING]: 'CLOSING',
                [WebSocket.CLOSED]: 'CLOSED'
            };
            const state = stateNames[ws.readyState] || `STATE_${ws.readyState}`;
            acc[state] = (acc[state] || 0) + 1;
            return acc;
        }, {});

        return {
            trackedSymbols: this.symbols.length,
            activeSockets: this.activeSockets.length,
            socketStates,
            messagesReceived: this.messagesReceived,
            liquidationsProcessed: this.liquidationsProcessed,
            pendingAggregates: this.aggregationBuffers.size,
            pendingCascades: this.cascadeBuffers.size,
            aggregatesSent: this.aggregatesSent,
            cascadesSent: this.cascadesSent,
            disbalanceAlertsSent: this.disbalanceAlertsSent,
            lastLiquidationAt: this.lastLiquidationAt ? new Date(this.lastLiquidationAt).toISOString() : null
        };
    }

    private closeSockets(): void {
        this.activeSockets.forEach(ws => {
            ws.removeAllListeners();
            ws.terminate();
        });
        this.activeSockets = [];

        this.keepAliveIntervals.forEach(clearInterval);
        this.keepAliveIntervals = [];

        this.reconnectTimeouts.forEach(clearTimeout);
        this.reconnectTimeouts = [];
    }

    private connectChunk(chunkSymbols: string[], chunkId: number): void {
        // Формируем URL для комбинированного стрима: stream?streams=btcusdt@forceOrder/ethusdt@forceOrder...
        const streams = chunkSymbols.map(s => `${s.toLowerCase()}@forceOrder`).join('/');
        const wsURL = `${this.getMarketStreamBaseUrl()}/stream?streams=${streams}`;
        
        const ws = new WebSocket(wsURL);
        let pingInterval: NodeJS.Timeout | undefined;
        this.activeSockets.push(ws);

        ws.on('open', () => {
            console.log(`✅ [Chunk ${chunkId}] Connected (${chunkSymbols.length} pairs).`);
            // Простейший пинг, чтобы соединение не висело мертвым грузом
            pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, 30000);
            this.keepAliveIntervals.push(pingInterval);
        });

        ws.on('message', (data: WebSocket.Data) => {
            try {
                this.messagesReceived++;
                const parsedMessage = JSON.parse(data.toString());
                // Формат combined stream: { "stream": "...", "data": { ... payload ... } }
                const payload = parsedMessage.data;

                if (payload && payload.e === 'forceOrder') {
                    this.processLiquidation(payload.o);
                }
            } catch (error) {
                console.error(`[Chunk ${chunkId}] Error parsing message:`, error);
            }
        });

        ws.on('error', (error) => {
            console.error(`❌ [Chunk ${chunkId}] WebSocket error:`, error.message);
        });
        
        ws.on('close', (code, reason) => {
            this.activeSockets = this.activeSockets.filter(socket => socket !== ws);
            if (pingInterval) {
                clearInterval(pingInterval);
                this.keepAliveIntervals = this.keepAliveIntervals.filter(interval => interval !== pingInterval);
            }

            if (this.isRestarting || this.isStopping) return; // Если мы сами перезагружаем, не пытаемся реконнектиться отдельно
            
            const reasonString = reason.toString() || 'No reason specified';
            console.log(`🔌 [Chunk ${chunkId}] Disconnected (Code: ${code}. Reason: ${reasonString}). Reconnecting...`);
            const timeout = setTimeout(() => {
                this.reconnectTimeouts = this.reconnectTimeouts.filter(item => item !== timeout);
                this.connectChunk(chunkSymbols, chunkId);
            }, 5000);
            this.reconnectTimeouts.push(timeout);
        });
    }

    private getMarketStreamBaseUrl(): string {
        try {
            const url = new URL(this.wsBaseUrl);
            const route = url.pathname.replace(/\/+$/, '');

            if (!route || route === '/' || route === '/ws' || route === '/stream') {
                url.pathname = '/market';
            } else if (route !== '/market') {
                console.warn(`⚠️ FUTURES_WS_URL route "${route}" is not valid for liquidation streams. Using /market.`);
                url.pathname = '/market';
            }

            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/+$/, '');
        } catch (error) {
            console.warn(`⚠️ Invalid FUTURES_WS_URL "${this.wsBaseUrl}". Falling back to Binance market endpoint.`);
            return 'wss://fstream.binance.com/market';
        }
    }

    private processLiquidation(orderData: any): void {
        const liquidation: LiquidationData = {
            symbol: orderData.s,
            side: orderData.S === 'BUY' ? 'short liquidation' : 'long liquidation',
            price: parseFloat(orderData.p),
            quantity: parseFloat(orderData.q),
            time: new Date(orderData.T).toISOString(),
        };
        
        this.liquidationsProcessed++;
        this.lastLiquidationAt = Date.now();
        
        const value = liquidation.price * liquidation.quantity;
        // Логируем только крупные, чтобы не спамить в консоль
        if (value > 10000) {
             console.log(`📥 [${liquidation.symbol}] Buffered ${liquidation.side}: $${value.toFixed(2)}`);
        }

        this.bufferLiquidation(liquidation);
        this.bufferCascade(liquidation);
        this.recordImbalance(liquidation);
    }

    private getSide(liquidation: LiquidationData): LiquidationSide {
        return liquidation.side === 'long liquidation' ? 'long' : 'short';
    }

    private getBufferKey(symbol: string, side: LiquidationSide): string {
        return `${symbol}:${side}`;
    }

    private createBuffer(liquidation: LiquidationData, windowSeconds: number, onFlush: (key: string) => void): BufferedLiquidations {
        const side = this.getSide(liquidation);
        const key = this.getBufferKey(liquidation.symbol, side);
        const value = liquidation.price * liquidation.quantity;
        const startTime = new Date(liquidation.time).getTime();
        const timer = setTimeout(() => onFlush(key), windowSeconds * 1000);

        return {
            symbol: liquidation.symbol,
            side,
            count: 1,
            totalVolume: value,
            totalQuantity: liquidation.quantity,
            minPrice: liquidation.price,
            maxPrice: liquidation.price,
            firstPrice: liquidation.price,
            lastPrice: liquidation.price,
            startTime,
            endTime: startTime,
            timer
        };
    }

    private updateBuffer(buffer: BufferedLiquidations, liquidation: LiquidationData): void {
        const value = liquidation.price * liquidation.quantity;
        buffer.count += 1;
        buffer.totalVolume += value;
        buffer.totalQuantity += liquidation.quantity;
        buffer.minPrice = Math.min(buffer.minPrice, liquidation.price);
        buffer.maxPrice = Math.max(buffer.maxPrice, liquidation.price);
        buffer.lastPrice = liquidation.price;
        buffer.endTime = new Date(liquidation.time).getTime();
    }

    private bufferLiquidation(liquidation: LiquidationData): void {
        const side = this.getSide(liquidation);
        const key = this.getBufferKey(liquidation.symbol, side);
        const existing = this.aggregationBuffers.get(key);

        if (existing) {
            this.updateBuffer(existing, liquidation);
            return;
        }

        this.aggregationBuffers.set(
            key,
            this.createBuffer(liquidation, REALTIME_AGGREGATION_WINDOW_SECONDS, flushKey => {
                this.flushAggregate(flushKey).catch(error => {
                    console.error(`[${flushKey}] Failed to flush liquidation aggregate.`, error);
                });
            })
        );
    }

    private bufferCascade(liquidation: LiquidationData): void {
        const side = this.getSide(liquidation);
        const key = this.getBufferKey(liquidation.symbol, side);
        const existing = this.cascadeBuffers.get(key);

        if (existing) {
            this.updateBuffer(existing, liquidation);
            return;
        }

        this.cascadeBuffers.set(
            key,
            this.createBuffer(liquidation, CASCADE_WINDOW_SECONDS, flushKey => {
                this.flushCascade(flushKey).catch(error => {
                    console.error(`[${flushKey}] Failed to flush cascade buffer.`, error);
                });
            })
        );
    }

    private async flushAggregate(key: string): Promise<void> {
        const buffer = this.aggregationBuffers.get(key);
        if (!buffer) return;

        clearTimeout(buffer.timer);
        this.aggregationBuffers.delete(key);

        const minUserThreshold = await this.dbService.getMinimumUserThresholdForSymbol(buffer.symbol);
        const thresholds = [
            STORAGE_MIN_LIQUIDATION,
            TELEGRAM_CHANNEL_ID ? CHANNEL_MIN_LIQUIDATION : Number.POSITIVE_INFINITY,
            minUserThreshold ?? Number.POSITIVE_INFINITY
        ];
        const persistenceThreshold = Math.min(...thresholds);

        if (buffer.totalVolume >= persistenceThreshold) {
            const avgPrice = buffer.totalQuantity > 0 ? buffer.totalVolume / buffer.totalQuantity : buffer.lastPrice;
            await this.dbService.saveLiquidation({
                symbol: buffer.symbol,
                side: buffer.side === 'long' ? 'long liquidation' : 'short liquidation',
                price: avgPrice,
                quantity: avgPrice > 0 ? buffer.totalVolume / avgPrice : 0,
                time: new Date(buffer.endTime).toISOString(),
                count: buffer.count,
                isAggregate: true,
                windowSeconds: REALTIME_AGGREGATION_WINDOW_SECONDS,
                minPrice: buffer.minPrice,
                maxPrice: buffer.maxPrice
            });
        }

        if (
            buffer.totalVolume >= CHANNEL_MIN_LIQUIDATION ||
            (minUserThreshold !== null && buffer.totalVolume >= minUserThreshold)
        ) {
            await this.telegramService.sendAggregatedLiquidationAlert({
                symbol: buffer.symbol,
                side: buffer.side,
                count: buffer.count,
                totalVolume: buffer.totalVolume,
                minPrice: buffer.minPrice,
                maxPrice: buffer.maxPrice,
                firstPrice: buffer.firstPrice,
                lastPrice: buffer.lastPrice,
                startTime: buffer.startTime,
                endTime: buffer.endTime,
                windowSeconds: REALTIME_AGGREGATION_WINDOW_SECONDS
            });
            this.aggregatesSent++;
        }
    }

    private async flushCascade(key: string): Promise<void> {
        const buffer = this.cascadeBuffers.get(key);
        if (!buffer) return;

        clearTimeout(buffer.timer);
        this.cascadeBuffers.delete(key);

        if (buffer.count < CASCADE_MIN_ORDERS || buffer.totalVolume < CASCADE_MIN_VOLUME) return;

        await this.telegramService.sendCascadeAlert(buffer.symbol, {
            count: buffer.count,
            totalVolume: buffer.totalVolume,
            minPrice: buffer.minPrice,
            maxPrice: buffer.maxPrice,
            side: buffer.side,
            startTime: buffer.startTime
        });
        this.cascadesSent++;
    }

    private recordImbalance(liquidation: LiquidationData): void {
        const value = liquidation.price * liquidation.quantity;
        const point: ImbalancePoint = {
            time: new Date(liquidation.time).getTime(),
            longs: liquidation.side === 'long liquidation' ? value : 0,
            shorts: liquidation.side === 'short liquidation' ? value : 0
        };

        const points = this.imbalanceWindows.get(liquidation.symbol) || [];
        points.push(point);
        this.imbalanceWindows.set(liquidation.symbol, points);
    }

    private async checkImbalances(): Promise<void> {
        const now = Date.now();
        const windowMs = DISBALANCE_WINDOW_MINUTES * 60 * 1000;
        const cooldownMs = windowMs;

        for (const [symbol, points] of this.imbalanceWindows.entries()) {
            const recent = points.filter(point => point.time >= now - windowMs);
            if (recent.length === 0) {
                this.imbalanceWindows.delete(symbol);
                continue;
            }
            this.imbalanceWindows.set(symbol, recent);

            const longs = recent.reduce((sum, point) => sum + point.longs, 0);
            const shorts = recent.reduce((sum, point) => sum + point.shorts, 0);
            const dominant = Math.max(longs, shorts);
            const weak = Math.max(Math.min(longs, shorts), 1);
            const ratio = dominant / weak;
            const cooldownKey = `${symbol}:${longs >= shorts ? 'long' : 'short'}`;

            if (dominant < DISBALANCE_MIN_VOLUME || ratio < DISBALANCE_RATIO) continue;
            if ((this.imbalanceAlertCooldowns.get(cooldownKey) || 0) > now - cooldownMs) continue;

            await this.telegramService.sendDisbalanceAlert({
                symbol,
                longs,
                shorts,
                ratio,
                windowMinutes: DISBALANCE_WINDOW_MINUTES
            });
            this.imbalanceAlertCooldowns.set(cooldownKey, now);
            this.disbalanceAlertsSent++;
        }
    }
}
