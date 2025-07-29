// src/services/LiquidityMapService.ts

import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartConfiguration, Plugin, ChartTypeRegistry } from 'chart.js';
import AnnotationPlugin, { AnnotationOptions } from 'chartjs-plugin-annotation';

type OrderBookData = { bids: [string, string][]; asks: [string, string][]; };
type LiquidityLevel = { price: number; volume: number; };
type ClusteredLevel = { price: number; totalVolume: number; count: number };
type SymbolInfo = { tickSize: number; };

export class LiquidityMapService {
    private readonly chartWidth = 1400;
    private readonly chartHeight = 1000;
    private readonly chartJSNodeCanvas: ChartJSNodeCanvas;
    private symbolInfoCache = new Map<string, SymbolInfo>();

    constructor() {
        this.chartJSNodeCanvas = new ChartJSNodeCanvas({
            width: this.chartWidth, height: this.chartHeight, backgroundColour: '#1E222D',
            plugins: { modern: [AnnotationPlugin] }
        });
        console.log('LiquidityMapService initialized with asset-specific logic.');
    }

    private async getSymbolInfo(symbol: string): Promise<SymbolInfo | null> {
        if (this.symbolInfoCache.has(symbol)) return this.symbolInfoCache.get(symbol)!;
        try {
            const url = `https://fapi.binance.com/fapi/v1/exchangeInfo`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            const symbolData = data.symbols.find((s: any) => s.symbol === symbol);
            if (!symbolData) return null;
            const tickSizeFilter = symbolData.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
            const tickSize = tickSizeFilter ? parseFloat(tickSizeFilter.tickSize) : 0.01;
            const info = { tickSize };
            this.symbolInfoCache.set(symbol, info);
            return info;
        } catch (error) {
            console.error(`[${symbol}] Error fetching exchange info:`, error);
            return null;
        }
    }

    private async fetchOrderBook(symbol: string, exchange: 'binance' | 'bybit'): Promise<OrderBookData | null> {
        try {
            const url = exchange === 'binance'
                ? `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol.toUpperCase()}&limit=1000`
                : `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol.toUpperCase()}&limit=500`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            if (exchange === 'bybit' && data.result) return { bids: data.result.b || [], asks: data.result.a || [] };
            return data;
        } catch (error) {
            console.error(`[${exchange.toUpperCase()} FUTURES] Error fetching order book:`, error);
            return null;
        }
    }
    
    private analyzeLiquidity(books: (OrderBookData | null)[], aggregation: number): { longs: LiquidityLevel[], shorts: LiquidityLevel[] } {
        const longsMap = new Map<number, number>();
        const shortsMap = new Map<number, number>();
        for (const book of books) {
            if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) continue;
            for (const [priceStr, quantityStr] of book.bids) {
                const price = parseFloat(priceStr);
                const volume = price * parseFloat(quantityStr);
                longsMap.set(Math.floor(price / aggregation) * aggregation, (longsMap.get(Math.floor(price / aggregation) * aggregation) || 0) + volume);
            }
            for (const [priceStr, quantityStr] of book.asks) {
                const price = parseFloat(priceStr);
                const volume = price * parseFloat(quantityStr);
                shortsMap.set(Math.ceil(price / aggregation) * aggregation, (shortsMap.get(Math.ceil(price / aggregation) * aggregation) || 0) + volume);
            }
        }
        return { 
            longs: Array.from(longsMap.entries()).map(([price, volume]) => ({ price, volume })),
            shorts: Array.from(shortsMap.entries()).map(([price, volume]) => ({ price, volume }))
        };
    }
    
    private clusterLevels(levels: LiquidityLevel[], minDistance: number): ClusteredLevel[] {
        if (levels.length === 0) return [];

        const sortedLevels = [...levels].sort((a, b) => a.price - b.price);
        const clustered: ClusteredLevel[] = [];

        let currentCluster = {
            totalVolume: sortedLevels[0].volume,
            priceWithMaxVolume: sortedLevels[0].price,
            levels: [sortedLevels[0]]
        };

        for (let i = 1; i < sortedLevels.length; i++) {
            const level = sortedLevels[i];
            const priceDifference = Math.abs(level.price - currentCluster.priceWithMaxVolume) / currentCluster.priceWithMaxVolume;

            if (priceDifference < minDistance) {
                currentCluster.levels.push(level);
                currentCluster.totalVolume += level.volume;
                if (level.volume > currentCluster.levels.find(l => l.price === currentCluster.priceWithMaxVolume)!.volume) {
                    currentCluster.priceWithMaxVolume = level.price;
                }
            } else {
                if (currentCluster.levels.length > 0) {
                     clustered.push({
                        price: currentCluster.priceWithMaxVolume,
                        totalVolume: currentCluster.totalVolume,
                        count: currentCluster.levels.length
                    });
                }
                currentCluster = { totalVolume: level.volume, priceWithMaxVolume: level.price, levels: [level] };
            }
        }
        
        clustered.push({
            price: currentCluster.priceWithMaxVolume,
            totalVolume: currentCluster.totalVolume,
            count: currentCluster.levels.length
        });

        return clustered;
    }

    public async generateLiquidityMap(symbol: string): Promise<Buffer | null> {
        console.log(`[${symbol}] Generating aggregated futures liquidity map...`);
        
        const [symbolInfo, binanceBook, bybitBook] = await Promise.all([
            this.getSymbolInfo(symbol), this.fetchOrderBook(symbol, 'binance'), this.fetchOrderBook(symbol, 'bybit'),
        ]);

        if (!symbolInfo || (!binanceBook && !bybitBook)) return null;
        
        const books = [binanceBook, bybitBook];
        const validBook = books.find(b => b && b.bids.length > 0 && b.asks.length > 0);
        if (!validBook) return null;

        const midPrice = (parseFloat(validBook.bids[0][0]) + parseFloat(validBook.asks[0][0])) / 2;

        let aggregation: number;
        let minVolumeThreshold: number;
        let clusterDistance: number;
        
        if (symbol === 'BTCUSDT') {
            aggregation = symbolInfo.tickSize * 150;
            minVolumeThreshold = 1000;
            clusterDistance = 0.001; 
        } else if (symbol === 'ETHUSDT') {
            aggregation = symbolInfo.tickSize * 120;
            minVolumeThreshold = 2000;
            clusterDistance = 0.0015;
        } else {
            aggregation = symbolInfo.tickSize * 100;
            minVolumeThreshold = 500;
            clusterDistance = 0.005;
        }


        const { longs, shorts } = this.analyzeLiquidity(books, aggregation);

        const filterAndSort = (levels: LiquidityLevel[]) => levels
            .filter(l => l.volume > minVolumeThreshold)
            .sort((a, b) => a.price - b.price);

        const longsData = filterAndSort(longs);
        const shortsData = filterAndSort(shorts);
        
        const clusteredLongs = this.clusterLevels(longsData, clusterDistance);
        const clusteredShorts = this.clusterLevels(shortsData, clusterDistance);
        
        const totalLongsVolume = clusteredLongs.reduce((sum, l) => sum + l.totalVolume, 0);
        const totalShortsVolume = clusteredShorts.reduce((sum, l) => sum + l.totalVolume, 0);
        const totalVolume = totalLongsVolume + totalShortsVolume;
        
        let dominanceText = '';
        if (totalVolume > 0) {
            const longDominance = (totalLongsVolume / totalVolume) * 100;
            if (longDominance > 55) {
                dominanceText = `(Buyer Dominance: ${longDominance.toFixed(0)}%)`;
            } else if (longDominance < 45) {
                dominanceText = `(Seller Dominance: ${(100 - longDominance).toFixed(0)}%)`;
            }
        }
        
    
        const getTopLevels = (levels: LiquidityLevel[], count = 3) => {
            return [...levels].sort((a, b) => b.volume - a.volume).slice(0, count).map(l => l.price);
        };

        const topLongPrices = getTopLevels(longsData);
        const topShortPrices = getTopLevels(shortsData);

        const getColor = (price: number, topPrices: number[], type: 'long' | 'short') => {
            const isTop = topPrices.includes(price);
            if (type === 'long') {
                return isTop ? 'rgba(38, 166, 154, 0.9)' : 'rgba(38, 166, 154, 0.25)'; 
            } else {
                return isTop ? 'rgba(239, 83, 80, 0.9)' : 'rgba(239, 83, 80, 0.25)'; 
            }
        };

        const createAnnotation = (level: ClusteredLevel): AnnotationOptions => {
            return {
                type: 'line',
                yMin: level.price,
                yMax: level.price,
                borderColor: '#FFD700',
                borderWidth: 1.5,
                borderDash: [5, 5],
                label: {
                    content: `Σ $${(level.totalVolume / 1000000).toFixed(1)}M (${level.count} levels)`,
                    display: true,
                    position: 'end',
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    font: { size: 12 },
                    color: '#FFD700'
                }
            };
        };

        const significantAnnotations = [...clusteredLongs, ...clusteredShorts].map(createAnnotation);

        const midPriceLine: Plugin<keyof ChartTypeRegistry> = {
            id: 'midPriceLine',
            afterDraw: (chart) => {
                const ctx = chart.ctx;
                const yAxis = chart.scales.y;
                const yValue = yAxis.getPixelForValue(midPrice);
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yValue);
                ctx.lineTo(chart.chartArea.right, yValue);
                ctx.strokeStyle = '#FFD700';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.fillStyle = '#FFD700';
                ctx.font = 'bold 14px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(midPrice.toFixed(midPrice < 1 ? 4 : 2), 10, yValue - 5);
                ctx.restore();
            }
        };

        const allPricesFromBooks = [...(binanceBook?.bids || []), ...(binanceBook?.asks || []), ...(bybitBook?.bids || []), ...(bybitBook?.asks || [])]
            .map(([price]) => parseFloat(price));
        const minPrice = Math.min(...allPricesFromBooks);
        const maxPrice = Math.max(...allPricesFromBooks);
        const dynamicPriceRange = (maxPrice - minPrice) * 1.5;
        const yMin = midPrice - dynamicPriceRange / 2;
        const yMax = midPrice + dynamicPriceRange / 2;

        const configuration: ChartConfiguration = {
            type: 'bar',
            data: {
                datasets: [
                    { 
                        label: 'Longs (Buy Walls)', 
                        data: longsData.map(l => ({ y: l.price, x: l.volume })), 
                        backgroundColor: longsData.map(l => getColor(l.price, topLongPrices, 'long'))
                    },
                    { 
                        label: 'Shorts (Sell Walls)', 
                        data: shortsData.map(l => ({ y: l.price, x: l.volume })),
                        backgroundColor: shortsData.map(l => getColor(l.price, topShortPrices, 'short'))
                    }
                ]
            },
            options: {
                indexAxis: 'y',
                responsive: false,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: [`Futures Liquidity Map for ${symbol.toUpperCase()} (Binance + Bybit)`, dominanceText], color: '#FFFFFF', font: { size: 20 } },
                    legend: { position: 'top', labels: { color: '#FFFFFF' } },
                    annotation: { annotations: significantAnnotations },
                    tooltip: {
                         callbacks: {
                            label: (context) => {
                                const side = context.dataset.label || '';
                                const value = context.parsed.x;
                                return `${side}: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { type: 'logarithmic', title: { display: true, text: 'Volume (USD, Logarithmic Scale)', color: '#FFFFFF'}, ticks: { color: '#B0B3B8', callback: (value) => {const num = Number(value); if (num >= 1000000) return `${(num / 1000000).toFixed(0)}M`; if (num >= 1000) return `${(num / 1000).toFixed(0)}K`; return num.toString();}}},
                    y: { 
                        type: 'linear', reverse: false, title: { display: true, text: 'Price (USD)', color: '#FFFFFF' },
                        min: yMin,
                        max: yMax
                    },
                }
            },
            plugins: [midPriceLine, AnnotationPlugin]
        };

        return this.chartJSNodeCanvas.renderToBuffer(configuration);
    }
}