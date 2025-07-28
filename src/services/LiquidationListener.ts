// src/services/LiquidationListener.ts

import WebSocket from 'ws';
import { DatabaseService, LiquidationData } from './DatabaseService';
import { TelegramService } from './TelegramService';

export class LiquidationListener {
    private symbols: string[];
    private dbService: DatabaseService;
    private telegramService: TelegramService;
    private wsBaseUrl: string;
    private connections: Map<string, WebSocket> = new Map();

    constructor(symbolsToTrack: string[], dbService: DatabaseService, telegramService: TelegramService, wsBaseUrl: string) {
        this.symbols = symbolsToTrack;
        this.dbService = dbService;
        this.telegramService = telegramService;
        this.wsBaseUrl = wsBaseUrl;
        console.log('LiquidationListener initialized to permanently track symbols:', this.symbols.join(', '));
    }

    public start(): void {
        console.log('Starting permanent WebSocket listeners for all configured pairs...');
        this.symbols.forEach(symbol => {
            this.connect(symbol);
        });
    }

    private connect(symbol: string): void {
        if (this.connections.has(symbol)) {
             return;
        }

        const streamName = `${symbol.toLowerCase()}@forceOrder`;
        const wsURL = `${this.wsBaseUrl}/ws/${streamName}`;
        
        const ws = new WebSocket(wsURL);
        this.connections.set(symbol, ws);

        ws.on('open', () => {
            console.log(`✅ [${symbol}] Successfully connected to WebSocket stream.`);
        });

        ws.on('message', (data: WebSocket.Data) => {
            try {
                const parsedData = JSON.parse(data.toString());
                if (parsedData.e === 'forceOrder') {
                    const liquidation: LiquidationData = {
                        symbol: parsedData.o.s,
                        side: parsedData.o.S === 'BUY' ? 'short liquidation' : 'long liquidation',
                        price: parseFloat(parsedData.o.p),
                        quantity: parseFloat(parsedData.o.q),
                        time: new Date(parsedData.o.T).toISOString(),
                    };
                    
                    this.dbService.saveLiquidation(liquidation);
                    
                    const value = liquidation.price * liquidation.quantity;
                    console.log(`💾 [${liquidation.symbol}] Saved ${liquidation.side} of value $${value.toFixed(2)}`);

                    this.telegramService.sendRealtimeLiquidationAlert(liquidation);
                }
            } catch (error) {
                console.error(`[${symbol}] Error parsing message:`, error);
            }
        });

        ws.on('error', (error) => {
            console.error(`❌ [${symbol}] WebSocket error:`, error.message);
        });
        
        ws.on('close', (code, reason) => {
            const reasonString = reason.toString() || 'No reason specified';
            console.log(`🔌 [${symbol}] WebSocket disconnected. Code: ${code}. Reason: ${reasonString}.`);
            
            this.connections.delete(symbol);
            console.log(`[${symbol}] Reconnecting in 5 seconds...`);
            setTimeout(() => this.connect(symbol), 5000);
        });
    }
}