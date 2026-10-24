import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JobModule } from '../job/job.module.js';
import { Job } from '../job/job.entity.js';
import { ProjectModule } from '../project/project.module.js';

import { FeatureController } from './feature.controller.js';
import { Feature } from './feature.entity.js';
import { FeatureMapper } from './feature.mapper.js';
import { FeatureService } from './feature.service.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Feature,
            Job
        ]),
        ProjectModule,
        JobModule
    ],
    controllers: [
        FeatureController
    ],
    providers: [
        FeatureMapper,
        FeatureService
    ],
    exports: [
        FeatureService
    ]
})
export class FeatureModule { }
