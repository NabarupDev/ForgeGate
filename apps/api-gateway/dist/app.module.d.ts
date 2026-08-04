import { Response } from 'express';
import { MetricsService } from './metrics.service';
export declare class GatewayController {
    private readonly metricsService;
    constructor(metricsService: MetricsService);
    getHealth(): {
        status: string;
        service: string;
        timestamp: string;
    };
    getMetrics(res: Response): Promise<Response<any, Record<string, any>>>;
}
export declare class AppModule {
}
