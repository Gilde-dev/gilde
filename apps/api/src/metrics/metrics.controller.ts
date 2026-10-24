import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { MetricsQuerySchema, type MetricsQuery, type MetricsResponseDto } from './metrics.dto.js';
import { MetricsService } from './metrics.service.js';

@Controller('/v1/metrics')
export class MetricsController {

    constructor(private readonly metricsService: MetricsService) { }

    @Get()
    get(@Query(new ZodValidationPipe(MetricsQuerySchema)) q: MetricsQuery): Promise<MetricsResponseDto> {
        return this.metricsService.get(q);
    }
}
