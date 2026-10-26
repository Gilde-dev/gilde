import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';

import { AgentUsage } from './agent-usage.entity.js';
import { OtelController } from './otel.controller.js';
import { OTEL_RATE_TTL_MS, DEFAULT_OTEL_RATE_LIMIT } from './otel.config.js';
import { OtelService } from './otel.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([AgentUsage]),
        // Own storage, separate from the login throttle in AuthModule; the effective limit comes from @Throttle on the controller.
        ThrottlerModule.forRoot([{ name: 'default', ttl: OTEL_RATE_TTL_MS, limit: DEFAULT_OTEL_RATE_LIMIT }]),
    ],
    controllers: [OtelController],
    providers: [OtelService],
    exports: [OtelService],
})
export class OtelModule { }
