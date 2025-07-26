// src/services/DatabaseService.ts

import { MongoClient, Db, WithId } from 'mongodb';

interface LiquidationData {
    symbol: string;
    side: 'short liquidation' | 'long liquidation';
    price: number;
    quantity: number;
    time: string;
}

export class DatabaseService {
    private client: MongoClient;
    private dbName: string;
    private db!: Db;

    constructor(uri: string, dbName: string) {
        this.client = new MongoClient(uri);
        this.dbName = dbName;
    }

    public async connect(): Promise<void> {
        try {
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            console.log(`✅ Successfully connected to MongoDB. Database: ${this.dbName}`);
        } catch (error) {
            console.error('❌ Could not connect to MongoDB.', error);
            process.exit(1);
        }
    }

    public async saveLiquidation(liquidation: LiquidationData): Promise<void> {
        const collectionName = liquidation.symbol;
        try {
            const collection = this.db.collection(collectionName);
            await collection.insertOne(liquidation);
            console.log(`💾 [${collectionName}] Saved liquidation at price ${liquidation.price}`);
        } catch (error) {
            console.error(`[${collectionName}] Failed to save liquidation to database.`, error);
        }
    }
    
    public async getLiquidationsSince(collectionName: string, since: Date): Promise<WithId<LiquidationData>[]> {
        try {
            const collection = this.db.collection<LiquidationData>(collectionName);
            const liquidations = await collection.find({ time: { $gte: since.toISOString() } }).toArray();
            return liquidations;
        } catch (error) {
            console.error(`[${collectionName}] Failed to fetch liquidations from database.`, error);
            return [];
        }
    }
}