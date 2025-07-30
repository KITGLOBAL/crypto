import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartConfiguration, Plugin, ChartTypeRegistry } from 'chart.js';
import AnnotationPlugin, { AnnotationOptions } from 'chartjs-plugin-annotation';

type OrderBookData = { bids: [string, string][]; asks: [string, string][]; };
type LiquidityLevel = { price: number; volume: number; };
type ClusteredLevel = { price: number; totalVolume: number; count: number };
type SymbolInfo = { tickSize: number; };

const CHART_WIDTH = 1600;
const CHART_HEIGHT = 1200;
const BACKGROUND_COLOR = '#1E222D';
const TOP_LEVELS_COUNT = 3;
const COLOR_LONG_BASE = 'rgba(38, 166, 154, ';
const COLOR_LONG_TOP = 'rgba(20, 209, 61, ';
const COLOR_SHORT_BASE = 'rgba(239, 83, 80, ';
const COLOR_SHORT_TOP = 'rgba(240, 21, 17, ';
const ANNOTATION_COLOR = '#FFD700';
const MID_PRICE_COLOR = '#FFD700';
const EMPTY_ZONE_COLOR = 'rgba(100, 100, 100, 0.2)';

export class LiquidityMapService {
    private readonly chartJSNodeCanvas: ChartJSNodeCanvas;
    private symbolInfoCache = new Map<string, SymbolInfo>();

    constructor() {
        this.chartJSNodeCanvas = new ChartJSNodeCanvas({
            width: CHART_WIDTH,
            height: CHART_HEIGHT,
            backgroundColour: BACKGROUND_COLOR,
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
        let currentCluster = { totalVolume: sortedLevels[0].volume, priceWithMaxVolume: sortedLevels[0].price, levels: [sortedLevels[0]] };

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

    private getTopLevels(levels: ClusteredLevel[], count: number): ClusteredLevel[] {
        return [...levels].sort((a, b) => b.totalVolume - a.totalVolume).slice(0, count);
    }

    private createAnnotation(level: ClusteredLevel, totalVolume: number): AnnotationOptions {
        const volumePercentage = totalVolume > 0 ? ((level.totalVolume / totalVolume) * 100).toFixed(1) : '0.0';
        return {
            type: 'line',
            yMin: level.price,
            yMax: level.price,
            borderColor: ANNOTATION_COLOR,
            borderWidth: 1.5,
            borderDash: [5, 5],
            label: {
                content: `Σ $${(level.totalVolume / 1000000).toFixed(1)}M (${level.count} levels, ${volumePercentage}%)`,
                display: true,
                position: 'end',
                backgroundColor: 'rgba(0,0,0,0.6)',
                font: { size: 12 },
                color: ANNOTATION_COLOR
            }
        };
    }

    private detectEmptyZones(clusteredLevels: ClusteredLevel[], minPrice: number, maxPrice: number, threshold: number): { start: number; end: number }[] {
        const zones: { start: number; end: number }[] = [];
        if (clusteredLevels.length === 0) return [{ start: minPrice, end: maxPrice }];
        let lastPrice = minPrice;
        for (const level of clusteredLevels.sort((a, b) => a.price - b.price)) {
            if (level.price - lastPrice > threshold) {
                zones.push({ start: lastPrice, end: level.price });
            }
            lastPrice = level.price;
        }
        if (maxPrice - lastPrice > threshold) {
            zones.push({ start: lastPrice, end: maxPrice });
        }
        return zones;
    }

    private createEmptyZoneAnnotation(zone: { start: number; end: number }): AnnotationOptions {
        return {
            type: 'box',
            yMin: zone.start,
            yMax: zone.end,
            backgroundColor: EMPTY_ZONE_COLOR,
            borderWidth: 0,
            label: { display: false, content: '' }
        };
    }

public async generateLiquidityMap(symbol: string): Promise<Buffer | null> {
    console.log(`[${symbol}] Generating aggregated futures liquidity map...`);

    const [symbolInfo, binanceBook, bybitBook] = await Promise.all([
        this.getSymbolInfo(symbol),
        this.fetchOrderBook(symbol, 'binance'),
        this.fetchOrderBook(symbol, 'bybit'),
    ]);

    if (!symbolInfo || (!binanceBook && !bybitBook)) {
        console.error(`[${symbol}] Failed to fetch symbol info or order books`);
        return null;
    }

    const books = [binanceBook, bybitBook].filter((b): b is OrderBookData => b !== null && b.bids.length > 0 && b.asks.length > 0);
    if (books.length === 0) {
        console.error(`[${symbol}] No valid order book data found`);
        return null;
    }

    const allPricesFromBooks = [
        ...(binanceBook?.bids || []),
        ...(binanceBook?.asks || []),
        ...(bybitBook?.bids || []),
        ...(bybitBook?.asks || [])
    ].map(([price]) => parseFloat(price));
    const minPrice = allPricesFromBooks.length > 0 ? Math.min(...allPricesFromBooks) : 0;
    const maxPrice = allPricesFromBooks.length > 0 ? Math.max(...allPricesFromBooks) : 0;
    
    // Улучшенная проверка для midPrice с учетом возможных null значений
    const midPrice = books.length > 0 && books[0] && books[0].bids.length > 0 && books[0].asks.length > 0
        ? (parseFloat(books[0].bids[0]?.[0] || '0') + parseFloat(books[0].asks[0]?.[0] || '0')) / 2
        : minPrice + (maxPrice - minPrice) / 2;

    const priceRange = maxPrice - minPrice;

    let aggregation: number;
    let minVolumeThreshold: number;
    let clusterDistance: number;

    if (symbol === 'BTCUSDT') {
        aggregation = symbolInfo.tickSize * 150;
        minVolumeThreshold = 500;
        clusterDistance = 0.0001;
    } else if (symbol === 'ETHUSDT') {
        aggregation = symbolInfo.tickSize * 120;
        minVolumeThreshold = 500;
        clusterDistance = 0.00015;
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

    // Вычисляем maxVolume на основе индивидуальных объемов для корректной интенсивности цвета
    const allIndividualVolumes = [...longsData, ...shortsData].map(l => l.volume);
    const maxVolume = Math.max(...allIndividualVolumes, 1);

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

    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' });

    let pressureText = '';
    if (totalShortsVolume > 0) {
        const pressureRatio = (totalLongsVolume / totalShortsVolume).toFixed(2);
        pressureText = `[Pressure Ratio: ${pressureRatio}x]`;
    }

    const topLongs = this.getTopLevels(clusteredLongs, TOP_LEVELS_COUNT);
    const topShorts = this.getTopLevels(clusteredShorts, TOP_LEVELS_COUNT);
    const topLongPrices = topLongs.map(l => l.price);
    const topShortPrices = topShorts.map(l => l.price);

    const totalLevelsCount = longsData.length + shortsData.length;
    const averageVolume = totalVolume / (totalLevelsCount > 0 ? totalLevelsCount : 1);

    const getColor = (price: number, topPrices: number[], type: 'long' | 'short', volume: number) => {
        const isTop = topPrices.includes(price);
        const intensity = Math.min(0.9, Math.max(0.1, volume / maxVolume));
        if (type === 'long') {
            return isTop ? `${COLOR_LONG_TOP}${intensity})` : `${COLOR_LONG_BASE}${intensity})`;
        } else {
            return isTop ? `${COLOR_SHORT_TOP}${intensity})` : `${COLOR_SHORT_BASE}${intensity})`;
        }
    };

    // Создаем аннотации для всех индивидуальных уровней
    const createLevelAnnotation = (price: number, volume: number, type: 'long' | 'short', totalVolume: number): AnnotationOptions => {
        const volumePercentage = totalVolume > 0 ? ((volume / totalVolume) * 100).toFixed(1) : '0.0';
        return {
            type: 'line',
            yMin: price,
            yMax: price,
            borderColor: ANNOTATION_COLOR,
            borderWidth: 1,
            borderDash: [2, 2],
            label: {
                content: `$${volume.toFixed(1)}K (${volumePercentage}%)`,
                display: true,
                position: 'end',
                backgroundColor: 'rgba(0,0,0,0.6)',
                font: { size: 10 },
                color: ANNOTATION_COLOR
            }
        };
    };

    const allLevelAnnotations = [
        ...longsData.map(l => createLevelAnnotation(l.price, l.volume / 1000, 'long', totalVolume)), // Делим на 1000 для отображения в тысячах
        ...shortsData.map(l => createLevelAnnotation(l.price, l.volume / 1000, 'short', totalVolume))
    ];

    const significantAnnotations = [
        ...topLongs.map(level => this.createAnnotation(level, totalVolume)),
        ...topShorts.map(level => this.createAnnotation(level, totalVolume))
    ];

    const clusteredLevels = [...clusteredLongs, ...clusteredShorts].filter(l => l.totalVolume > 0);
    const emptyZones = this.detectEmptyZones(clusteredLevels, minPrice, maxPrice, priceRange * 0.01);
    const emptyZoneAnnotations = emptyZones.map(zone => this.createEmptyZoneAnnotation(zone));

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
            ctx.strokeStyle = MID_PRICE_COLOR;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = MID_PRICE_COLOR;
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(midPrice.toFixed(midPrice < 1 ? 4 : 2), 10, yValue - 5);
            ctx.restore();
        }
    };

    const dynamicPriceRange = (maxPrice - minPrice) * 1.7;
    const yMin = midPrice - dynamicPriceRange / 2;
    const yMax = midPrice + dynamicPriceRange / 2;

    const configuration: ChartConfiguration = {
        type: 'bar',
        data: {
            datasets: [
                {
                    label: 'Longs (Buy Walls)',
                    data: longsData.map(l => ({ y: l.price, x: l.volume })),
                    backgroundColor: longsData.map(l => getColor(l.price, topLongPrices, 'long', l.volume))
                },
                {
                    label: 'Shorts (Sell Walls)',
                    data: shortsData.map(l => ({ y: l.price, x: l.volume })),
                    backgroundColor: shortsData.map(l => getColor(l.price, topShortPrices, 'short', l.volume))
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: false,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: [
                        `Futures Liquidity Map for ${symbol.toUpperCase()} (Binance + Bybit)`,
                        `${pressureText} [Total Volume: $${(totalVolume / 1000000).toFixed(1)}M, Price Range: $${priceRange.toFixed(2)}]`,
                        `Updated: ${timestamp} UTC | Generated by @liquidationsAggregator_bot`,
                        dominanceText
                    ],
                    color: '#FFFFFF',
                    font: { size: 20 }
                },
                legend: { position: 'top', labels: { color: '#FFFFFF' } },
                annotation: { annotations: [...allLevelAnnotations, ...significantAnnotations, ...emptyZoneAnnotations] },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const side = context.dataset.label || '';
                            const value = context.parsed.x;
                            const price = context.parsed.y;
                            const volumePercentage = totalVolume > 0 ? ((value / totalVolume) * 100).toFixed(1) : '0.0';
                            return `${side}: $${(value / 1000000).toFixed(1)}M @ ${price.toFixed(2)} (${volumePercentage}% of total)`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'logarithmic',
                    title: { display: true, text: 'Volume (USD, Logarithmic Scale)', color: '#FFFFFF' },
                    ticks: {
                        color: '#B0B3B8',
                        callback: (value) => {
                            const num = Number(value);
                            if (num >= 1000000) return `${(num / 1000000).toFixed(0)}M`;
                            if (num >= 1000) return `${(num / 1000).toFixed(0)}K`;
                            return num.toString();
                        }
                    }
                },
                y: {
                    type: 'linear',
                    reverse: false,
                    title: { display: false },
                    min: yMin,
                    max: yMax
                }
            }
        },
        plugins: [midPriceLine, AnnotationPlugin]
    };

    return this.chartJSNodeCanvas.renderToBuffer(configuration);
}
}