// src/services/LiquidationListener.ts

import WebSocket from 'ws';
import { DatabaseService, LiquidationData } from './DatabaseService';
import { TelegramService } from './TelegramService';

export class LiquidationListener {
    private symbols: string[];
    private dbService: DatabaseService;
    private telegramService: TelegramService;
    private wsBaseUrl: string;
    // Храним массив сокетов, так как теперь их будет несколько (по 1 на пачку символов)
    private activeSockets: WebSocket[] = [];
    private keepAliveIntervals: NodeJS.Timeout[] = [];
    private isRestarting = false;

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
    }

    public async restartConnections(): Promise<void> {
        console.log('♻️ Scheduled WebSocket restart (24h refresh)...');
        this.isRestarting = true;
        
        // Закрываем все текущие соединения
        this.activeSockets.forEach(ws => {
            ws.removeAllListeners();
            ws.terminate();
        });
        this.activeSockets = [];
        
        this.keepAliveIntervals.forEach(clearInterval);
        this.keepAliveIntervals = [];

        console.log('🔌 All connections closed. Waiting 5 seconds before reconnecting...');
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        this.isRestarting = false;
        this.start();
    }

    private connectChunk(chunkSymbols: string[], chunkId: number): void {
        // Формируем URL для комбинированного стрима: stream?streams=btcusdt@forceOrder/ethusdt@forceOrder...
        const streams = chunkSymbols.map(s => `${s.toLowerCase()}@forceOrder`).join('/');
        const wsURL = `${this.wsBaseUrl}/stream?streams=${streams}`;
        
        const ws = new WebSocket(wsURL);
        this.activeSockets.push(ws);

        ws.on('open', () => {
            console.log(`✅ [Chunk ${chunkId}] Connected (${chunkSymbols.length} pairs).`);
            // Простейший пинг, чтобы соединение не висело мертвым грузом
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, 30000);
            this.keepAliveIntervals.push(pingInterval);
        });

        ws.on('message', (data: WebSocket.Data) => {
            try {
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
            if (this.isRestarting) return; // Если мы сами перезагружаем, не пытаемся реконнектиться отдельно
            
            console.log(`🔌 [Chunk ${chunkId}] Disconnected (Code: ${code}). Reconnecting...`);
            setTimeout(() => this.connectChunk(chunkSymbols, chunkId), 5000);
        });
    }

    private processLiquidation(orderData: any): void {
        const liquidation: LiquidationData = {
            symbol: orderData.s,
            side: orderData.S === 'BUY' ? 'short liquidation' : 'long liquidation',
            price: parseFloat(orderData.p),
            quantity: parseFloat(orderData.q),
            time: new Date(orderData.T).toISOString(),
        };
        
        this.dbService.saveLiquidation(liquidation);
        
        const value = liquidation.price * liquidation.quantity;
        // Логируем только крупные, чтобы не спамить в консоль
        if (value > 10000) {
             console.log(`💾 [${liquidation.symbol}] Saved ${liquidation.side}: $${value.toFixed(2)}`);
        }

        this.telegramService.sendRealtimeLiquidationAlert(liquidation);
    }
}