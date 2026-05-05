import cron, { ScheduledTask } from 'node-cron';
import { ANALYSIS_SNAPSHOT_CRON, ANALYSIS_SNAPSHOT_ENABLED, ANALYSIS_TOP_SYMBOLS } from '../config';
import { AnalysisService } from '../analysis/AnalysisService';

export class AnalysisSnapshotService {
    private task?: ScheduledTask;
    private running = false;

    constructor(private analysisService: AnalysisService) {
        console.log('✅ AnalysisSnapshotService initialized.');
    }

    public start(): void {
        if (!ANALYSIS_SNAPSHOT_ENABLED) {
            console.log('ℹ️ Analysis snapshots disabled.');
            return;
        }

        this.task = cron.schedule(ANALYSIS_SNAPSHOT_CRON, () => {
            this.captureAll().catch(error => console.error('❌ Analysis snapshot job error:', error));
        });

        console.log(`📸 Analysis snapshots scheduled: ${ANALYSIS_SNAPSHOT_CRON}`);
    }

    public stop(): void {
        this.task?.stop();
        this.task = undefined;
        console.log('✅ Analysis snapshot job stopped.');
    }

    public async captureAll(): Promise<void> {
        if (this.running) {
            console.warn('⚠️ Analysis snapshot job skipped: previous run is still active.');
            return;
        }

        this.running = true;
        const startedAt = Date.now();
        let saved = 0;
        let failed = 0;

        try {
            console.log(`📸 Capturing analysis snapshots for ${ANALYSIS_TOP_SYMBOLS.length} symbols...`);
            for (const symbol of ANALYSIS_TOP_SYMBOLS) {
                try {
                    await this.analysisService.captureSnapshot(symbol);
                    saved += 1;
                } catch (error: any) {
                    failed += 1;
                    console.error(`❌ Snapshot failed for ${symbol}:`, error.message || error);
                }

                await this.delay(500);
            }

            const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
            console.log(`✅ Analysis snapshots completed: saved ${saved}, failed ${failed}, duration ${duration}s.`);
        } finally {
            this.running = false;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
