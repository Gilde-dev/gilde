import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { JobRun } from './run.entity.js';
import { RunMapper } from './run.mapper.js';
import { RunService } from './run.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            JobRun
        ])
    ],
    providers: [
        RunMapper,
        RunService
    ],
    exports: [
        RunService
    ]
})
export class RunModule { }
