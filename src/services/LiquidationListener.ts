// src/services/LiquidationListener.ts

import WebSocket from 'ws';
import { DatabaseService } from './DatabaseService';

interface LiquidationData {
    symbol: string;
    side: 'short liquidation' | 'long liquidation';
    price: number;
    quantity: number;
    time: string;
}

export class LiquidationListener {
    private symbols: string[];
    private dbService: DatabaseService;
    private wsBaseUrl: string;

    constructor(symbols: string[], dbService: DatabaseService, wsBaseUrl: string) {
        this.symbols = symbols;
        this.dbService = dbService;
        this.wsBaseUrl = wsBaseUrl;
        console.log('LiquidationListener initialized for symbols:', this.symbols.join(', '));
    }

    public start() {
        console.log('Starting listeners...');
        this.symbols.forEach(symbol => {
            this.connect(symbol);
        });
    }

    private connect(symbol: string) {
        const streamName = `${symbol.toLowerCase()}@forceOrder`;
        const wsURL = `${this.wsBaseUrl}/ws/${streamName}`;
        
        const ws = new WebSocket(wsURL);

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
                }
            } catch (error) {
                console.error(`[${symbol}] Error parsing message:`, error);
            }
        });

        ws.on('error', (error) => {
            console.error(`❌ [${symbol}] WebSocket error:`, error.message);
        });

        ws.on('close', (code, reason) => {
            console.log(`🔌 [${symbol}] WebSocket disconnected. Code: ${code}. Reason: ${reason.toString()}. Reconnecting in 5 seconds...`);
            setTimeout(() => this.connect(symbol), 5000);
        });
    }
}