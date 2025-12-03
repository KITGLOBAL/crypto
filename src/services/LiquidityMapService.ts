import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartConfiguration, Plugin, ChartTypeRegistry } from 'chart.js';
import AnnotationPlugin, { AnnotationOptions } from 'chartjs-plugin-annotation';

// --- TYPE DEFINITIONS ---
type OrderBookData = { bids: [string, string][]; asks: [string, string][]; };
type LiquidityLevel = { price: number; volume: number; };
type ClusteredLevel = { price: number; totalVolume: number; count: number };

// --- CONSTANTS ---
const CHART_WIDTH = 1600;
const CHART_HEIGHT = 1200;
const BACKGROUND_COLOR = '#1E222D';
const TOP_LEVELS_COUNT = 5; // Number of top clusters to annotate
const ANNOTATION_COLOR = '#FFD700';
const MID_PRICE_COLOR = '#4FC3F7';

// --- WHITEBIT CONFIGURATION ---
const WHITEBIT_CONFIG = {
  name: 'WhiteBIT',
  orderBookUrl: (symbol: string) => {
    const base = symbol.replace(/USDT/i, '').toUpperCase();
    return `https://whitebit.com/api/v4/public/orderbook/${base}_PERP?limit=500&level=3`;
  },
  responseMapper: (data: any): OrderBookData | null => {
    if (data && Array.isArray(data.asks) && Array.isArray(data.bids)) {
      return { bids: data.bids, asks: data.asks };
    }
    return null;
  }
};

export class LiquidityMapService {
  private readonly chartJSNodeCanvas: ChartJSNodeCanvas;

  constructor() {
    this.chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      backgroundColour: BACKGROUND_COLOR,
      plugins: { modern: [AnnotationPlugin] }
    });
    console.log('LiquidityMapService initialized for WhiteBIT.');
  }

  /**
   * Infers the tick size (minimum price increment) from the order book data.
   * This is determined by finding the maximum number of decimal places in any price level.
   * @param book The order book data.
   * @returns The inferred tick size.
   */
  private inferTickSize(book: OrderBookData): number {
      const allPrices = [...book.bids, ...book.asks];
      let maxDecimalPlaces = 0;

      for (const [priceStr] of allPrices) {
          if (priceStr.includes('.')) {
              const decimalPartLength = priceStr.split('.')[1].length;
              maxDecimalPlaces = Math.max(maxDecimalPlaces, decimalPartLength);
          }
      }
      
      if (maxDecimalPlaces === 0) {
          return 1; // If all prices are integers, the smallest increment is 1.
      }
      
      return parseFloat(`0.${'0'.repeat(maxDecimalPlaces - 1)}1`);
  }

  /**
   * Fetches the order book from WhiteBIT.
   * @param symbol The trading symbol (e.g., BTCUSDT).
   * @returns The order book data or null if an error occurs.
   */
  private async fetchOrderBook(symbol: string): Promise<OrderBookData | null> {
    try {
      const url = WHITEBIT_CONFIG.orderBookUrl(symbol);
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[${WHITEBIT_CONFIG.name}] Failed to fetch order book for ${symbol}: ${response.status}`);
        return null;
      }
      const data = await response.json();
      const result = WHITEBIT_CONFIG.responseMapper(data);
      if (!result) {
        console.error(`[${WHITEBIT_CONFIG.name}] Invalid order book data for ${symbol}`);
        return null;
      }
      return result;
    } catch (error) {
      console.error(`[${WHITEBIT_CONFIG.name}] Error fetching order book for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Analyzes and aggregates liquidity levels from a single order book.
   * @param book The order book data.
   * @param aggregation The price level to aggregate volumes by.
   * @returns Aggregated long and short liquidity levels.
   */
  private analyzeLiquidity(book: OrderBookData, aggregation: number): { longs: LiquidityLevel[], shorts: LiquidityLevel[] } {
    const longsMap = new Map<number, number>();
    const shortsMap = new Map<number, number>();

    for (const [priceStr, quantityStr] of book.bids) {
      const price = parseFloat(priceStr);
      const volume = price * parseFloat(quantityStr);
      const aggregatedPrice = Math.floor(price / aggregation) * aggregation;
      longsMap.set(aggregatedPrice, (longsMap.get(aggregatedPrice) || 0) + volume);
    }

    for (const [priceStr, quantityStr] of book.asks) {
      const price = parseFloat(priceStr);
      const volume = price * parseFloat(quantityStr);
      const aggregatedPrice = Math.ceil(price / aggregation) * aggregation;
      shortsMap.set(aggregatedPrice, (shortsMap.get(aggregatedPrice) || 0) + volume);
    }

    return {
      longs: Array.from(longsMap.entries()).map(([price, volume]) => ({ price, volume })),
      shorts: Array.from(shortsMap.entries()).map(([price, volume]) => ({ price, volume }))
    };
  }

  /**
   * Clusters liquidity levels that are close to each other.
   * @param levels A sorted array of liquidity levels.
   * @param minDistance The minimum relative distance to form a new cluster.
   * @returns An array of clustered liquidity levels.
   */
  private clusterLevels(levels: LiquidityLevel[], minDistance: number): ClusteredLevel[] {
    if (levels.length === 0) return [];
    
    const sortedLevels = [...levels].sort((a, b) => a.price - b.price);
    const clustered: ClusteredLevel[] = [];
    let currentCluster = {
        totalVolume: sortedLevels[0].volume,
        priceWithMaxVolume: sortedLevels[0].price,
        levels: [sortedLevels[0]],
    };

    for (let i = 1; i < sortedLevels.length; i++) {
        const level = sortedLevels[i];
        const priceDifference = Math.abs(level.price - currentCluster.priceWithMaxVolume) / currentCluster.priceWithMaxVolume;
        
        if (priceDifference < minDistance) {
            currentCluster.levels.push(level);
            currentCluster.totalVolume += level.volume;
            if (level.volume > (currentCluster.levels.find(l => l.price === currentCluster.priceWithMaxVolume)?.volume || 0)) {
                currentCluster.priceWithMaxVolume = level.price;
            }
        } else {
            clustered.push({
                price: currentCluster.priceWithMaxVolume,
                totalVolume: currentCluster.totalVolume,
                count: currentCluster.levels.length,
            });
            currentCluster = { totalVolume: level.volume, priceWithMaxVolume: level.price, levels: [level] };
        }
    }
    clustered.push({
        price: currentCluster.priceWithMaxVolume,
        totalVolume: currentCluster.totalVolume,
        count: currentCluster.levels.length,
    });

    return clustered;
  }
  
  /**
   * Gets the top N levels based on total volume.
   * @param levels The clustered levels.
   * @param count The number of top levels to return.
   * @returns An array of the top clustered levels.
   */
  private getTopLevels(levels: ClusteredLevel[], count: number): ClusteredLevel[] {
    return [...levels].sort((a, b) => b.totalVolume - a.totalVolume).slice(0, count);
  }

  /**
   * Creates an annotation for a significant clustered liquidity zone.
   * @param level The clustered level.
   * @param totalChartVolume The total volume on the chart for percentage calculation.
   * @returns Chart.js annotation options.
   */
  private createClusterAnnotation(level: ClusteredLevel, totalChartVolume: number): AnnotationOptions {
    const volumeMillions = (level.totalVolume / 1_000_000).toFixed(2);
    const volumePercentage = totalChartVolume > 0 ? ((level.totalVolume / totalChartVolume) * 100).toFixed(1) : '0.0';
    
    return {
      type: 'line',
      yMin: level.price,
      yMax: level.price,
      borderColor: ANNOTATION_COLOR,
      borderWidth: 2,
      borderDash: [6, 6],
      label: {
        content: `Σ $${volumeMillions}M (${level.count} levels, ${volumePercentage}%)`,
        display: true,
        position: 'end',
        backgroundColor: 'rgba(0,0,0,0.7)',
        font: { size: 14, weight: 'bold' },
        color: ANNOTATION_COLOR,
        padding: 6,
        borderRadius: 4,
      }
    };
  }

  /**
   * Generates a smooth gradient color based on volume.
   * @param volume The volume of the current level.
   * @param maxVolume The maximum volume on the chart.
   * @param type The side, 'long' or 'short'.
   * @returns An object with backgroundColor and borderColor strings.
   */
  private getGradientColor(volume: number, maxVolume: number, type: 'long' | 'short'): { backgroundColor: string, borderColor: string } {
    const longStart = { r: 20, g: 80, b: 75 };    // Dark, low-intensity teal
    const longEnd = { r: 60, g: 230, b: 220 };   // Bright, high-intensity cyan
    const shortStart = { r: 100, g: 40, b: 40 };  // Dark, low-intensity red
    const shortEnd = { r: 255, g: 90, b: 90 };   // Bright, high-intensity red

    const startColor = type === 'long' ? longStart : shortStart;
    const endColor = type === 'long' ? longEnd : shortEnd;

    // Use a power function (sqrt) for intensity to make the gradient more visually distinct
    const intensity = Math.pow(volume / maxVolume, 0.5);

    const r = Math.round(startColor.r + (endColor.r - startColor.r) * intensity);
    const g = Math.round(startColor.g + (endColor.g - startColor.g) * intensity);
    const b = Math.round(startColor.b + (endColor.b - startColor.b) * intensity);
    
    // Vary the alpha for a "glow" effect on larger volumes
    const backgroundColor = `rgba(${r}, ${g}, ${b}, ${0.3 + 0.6 * intensity})`;
    const borderColor = `rgba(${r}, ${g}, ${b}, ${0.5 + 0.5 * intensity})`;

    return { backgroundColor, borderColor };
  }
  
  /**
   * Calculates a "nice" step size for the Y-axis ticks to ensure readability.
   * @param range The price range (yMax - yMin) of the visible chart area.
   * @returns A clean, readable step number for the axis grid.
   */
  private calculateNiceStep(range: number): number {
    if (range <= 0) return 1;
    const desiredTicks = 8; // Aim for about 8 grid lines
    const roughStep = range / desiredTicks;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const residual = roughStep / magnitude;

    // Snap to a "nice" number (e.g., 1, 2, 5, 10)
    if (residual > 5) {
        return 10 * magnitude;
    } else if (residual > 2) {
        return 5 * magnitude;
    } else if (residual > 1) {
        return 2 * magnitude;
    } else {
        return magnitude;
    }
  }

  /**
   * Generates the liquidity map image buffer.
   * @param symbol The trading symbol (e.g., BTCUSDT).
   * @returns A Buffer containing the chart image, or null on failure.
   */
  public async generateLiquidityMap(symbol: string): Promise<Buffer | null> {
    console.log(`[${symbol}] Generating liquidity map from ${WHITEBIT_CONFIG.name}...`);

    const orderBook = await this.fetchOrderBook(symbol);
    if (!orderBook || orderBook.bids.length === 0 || orderBook.asks.length === 0) {
      console.error(`[${symbol}] Failed to fetch valid order book data from ${WHITEBIT_CONFIG.name}.`);
      return null;
    }

    const tickSize = this.inferTickSize(orderBook);
    const midPrice = (parseFloat(orderBook.bids[0][0]) + parseFloat(orderBook.asks[0][0])) / 2;

    // --- Dynamic Settings based on Price ---
    let aggregation: number;
    let clusterDistance: number;
    let minVolumeThreshold: number;

    if (midPrice > 20000) { // For high-priced assets like BTC
        aggregation = tickSize * 2000;
        clusterDistance = 0.0005; 
        minVolumeThreshold = 5000;
    } else if (midPrice > 1000) { // For mid-priced assets like ETH
        aggregation = tickSize * 200;
        clusterDistance = 0.001;
        minVolumeThreshold = 1000;
    } else { // For lower-priced assets
        aggregation = tickSize * 100;
        clusterDistance = 0.005;
        minVolumeThreshold = 500;
    }

    const { longs, shorts } = this.analyzeLiquidity(orderBook, aggregation);
    
    const filterAndSort = (levels: LiquidityLevel[]) => levels
      .filter(l => l.volume > minVolumeThreshold)
      .sort((a, b) => a.price - b.price);

    const longsData = filterAndSort(longs);
    const shortsData = filterAndSort(shorts);

    if (longsData.length === 0 && shortsData.length === 0) {
        console.error(`[${symbol}] No liquidity levels found after filtering.`);
        return null;
    }

    const clusteredLongs = this.clusterLevels(longsData, clusterDistance);
    const clusteredShorts = this.clusterLevels(shortsData, clusterDistance);

    const maxVolume = Math.max(...[...longsData, ...shortsData].map(l => l.volume), 1);
    
    const totalLongsVolume = clusteredLongs.reduce((sum, l) => sum + l.totalVolume, 0);
    const totalShortsVolume = clusteredShorts.reduce((sum, l) => sum + l.totalVolume, 0);
    const totalVolume = totalLongsVolume + totalShortsVolume;

    // --- Chart Title & Dominance ---
    let dominanceText = '';
    if (totalVolume > 0) {
      const longDominance = (totalLongsVolume / totalVolume) * 100;
      if (longDominance > 55) dominanceText = `Buyer Dominance: ${longDominance.toFixed(0)}%`;
      else if (longDominance < 45) dominanceText = `Seller Dominance: ${(100 - longDominance).toFixed(0)}%`;
    }
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' });

    // --- Annotations for Top Levels ---
    const topLongs = this.getTopLevels(clusteredLongs, TOP_LEVELS_COUNT);
    const topShorts = this.getTopLevels(clusteredShorts, TOP_LEVELS_COUNT);
    
    const significantAnnotations = [
      ...topLongs.map(level => this.createClusterAnnotation(level, totalVolume)),
      ...topShorts.map(level => this.createClusterAnnotation(level, totalVolume))
    ];

    // --- Mid Price Line Plugin ---
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
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(midPrice.toFixed(tickSize.toString().split('.')[1]?.length || 2), 15, yValue - 8);
        ctx.restore();
      }
    };

    // --- Dynamic Y-Axis Range ---
    const allPrices = [...longsData.map(l => l.price), ...shortsData.map(l => l.price)];
    const priceRange = Math.max(...allPrices) - Math.min(...allPrices);
    const yRange = Math.min(priceRange * 0.8, midPrice * 0.1); 
    const yMin = midPrice - yRange;
    const yMax = midPrice + yRange;
    const yStepSize = this.calculateNiceStep(yMax - yMin);

    // --- Prepare color data ---
    const colorDataLongs = longsData.map(l => this.getGradientColor(l.volume, maxVolume, 'long'));
    const colorDataShorts = shortsData.map(l => this.getGradientColor(l.volume, maxVolume, 'short'));

    const configuration: ChartConfiguration = {
      type: 'bar',
      data: {
        datasets: [
          {
            label: 'Longs (Buy Walls)',
            data: longsData.map(l => ({ y: l.price, x: l.volume })),
            backgroundColor: colorDataLongs.map(c => c.backgroundColor),
            borderColor: colorDataLongs.map(c => c.borderColor),
            borderWidth: 1,
          },
          {
            label: 'Shorts (Sell Walls)',
            data: shortsData.map(l => ({ y: l.price, x: l.volume })),
            backgroundColor: colorDataShorts.map(c => c.backgroundColor),
            borderColor: colorDataShorts.map(c => c.borderColor),
            borderWidth: 1,
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
              `Futures Liquidity Map for ${symbol.toUpperCase()} (${WHITEBIT_CONFIG.name})`,
              `Total Volume: $${(totalVolume / 1_000_000).toFixed(2)}M ${dominanceText}`,
              `Updated: ${timestamp} UTC | Generated by @liquidationsAggregator_bot`
            ],
            color: '#FFFFFF',
            font: { size: 22, weight: 'bold' }
          },
          legend: { position: 'top', labels: { color: '#FFFFFF', font: {size: 14} } },
          annotation: { annotations: significantAnnotations },
          tooltip: {
            callbacks: {
              label: (context) => {
                const side = context.dataset.label || '';
                const value = context.parsed.x;
                const price = context.parsed.y;
                return `${side}: $${(value / 1_000_000).toFixed(2)}M @ ${price.toFixed(tickSize.toString().split('.')[1]?.length || 2)}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'logarithmic',
            title: { display: true, text: 'Volume (USD, Logarithmic Scale)', color: '#FFFFFF', font: {size: 16} },
            ticks: {
              color: '#B0B3B8',
              callback: (value) => {
                const num = Number(value);
                if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(0)}M`;
                if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`;
                return num.toString();
              }
            },
            min: minVolumeThreshold,
          },
          y: {
            type: 'linear',
            reverse: false,
            title: { display: true, text: 'Price (USD)', color: '#FFFFFF', font: {size: 16}},
            min: yMin,
            max: yMax,
            ticks: { 
                color: '#B0B3B8', 
                stepSize: yStepSize 
            }
          }
        }
      },
      plugins: [midPriceLine, AnnotationPlugin]
    };

    return this.chartJSNodeCanvas.renderToBuffer(configuration);
  }
}
