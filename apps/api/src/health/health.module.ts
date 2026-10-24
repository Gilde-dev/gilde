import { Module } from '@nestjs/common';

import { HealthService } from './health.service.js';
import { HealthController } from './health.controller.js';

@Module({
    controllers: [HealthController],
    providers: [HealthService],
})
export class HealthModule { }
