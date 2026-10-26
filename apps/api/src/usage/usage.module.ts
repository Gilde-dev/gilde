import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsageController } from './usage.controller.js';
import { LlmUsage } from './usage.entity.js';
import { UsageService } from './usage.service.js';

/** Global so the co-pilot and the memory/history code can record usage without importing each other. */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([LlmUsage])],
    controllers: [UsageController],
    providers: [UsageService],
    exports: [UsageService],
})
export class UsageModule { }
