import { Injectable } from '@nestjs/common';
import { MetricsService as SharedMetricsService } from '@forgegate/common';

@Injectable()
export class MetricsService extends SharedMetricsService {
  constructor() {
    super();
  }
}
