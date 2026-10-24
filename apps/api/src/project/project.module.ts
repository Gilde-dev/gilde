import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectService } from './project.service.js';
import { ProjectMapper } from './project.mapper.js';
import { Project } from './project.entity.js';
import { ProjectController } from './project.controller.js';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Project
        ])
    ],
    controllers: [
        ProjectController
    ],
    providers: [
        ProjectService,
        ProjectMapper
    ],
    exports: [
        ProjectService
    ]
})
export class ProjectModule { }
