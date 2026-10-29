import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feature } from '../feature/feature.entity.js';
import { IntakeModule } from '../intake/intake.module.js';
import { IntakeItem } from '../intake/intake-item.entity.js';
import { Job } from '../job/job.entity.js';
import { JobModule } from '../job/job.module.js';
import { ProjectModule } from '../project/project.module.js';
import { RepoModule } from '../repo/repo.module.js';
import { UserModule } from '../user/user.module.js';

import { SpecApproval } from './spec-approval.entity.js';
import { SpecController } from './spec.controller.js';
import { Spec } from './spec.entity.js';
import { SpecMapper } from './spec.mapper.js';
import { SpecRecording } from './spec-recording.entity.js';
import { SpecService } from './spec.service.js';
import { SpecVersion } from './spec-version.entity.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([Spec, SpecVersion, SpecApproval, SpecRecording, Job, IntakeItem, Feature]),
        PassportModule.register({}),
        IntakeModule,
        JobModule,
        ProjectModule,
        RepoModule,
        UserModule,
    ],
    controllers: [SpecController],
    providers: [SpecMapper, SpecService],
    exports: [SpecService],
})
export class SpecModule { }
