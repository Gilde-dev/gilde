import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExecutorModule } from '../executor/executor.module.js';
import { ProjectModule } from '../project/project.module.js';
import { UserModule } from '../user/user.module.js';

import { ProjectMcpController } from './project-mcp.controller.js';
import { ProjectMcpConnector } from './project-mcp.connector.js';
import { ProjectMcpMapper } from './project-mcp.mapper.js';
import { ProjectMcpService } from './project-mcp.service.js';
import { ProjectMcpAudit } from './project-mcp-audit.entity.js';
import { ProjectMcpServer } from './project-mcp-server.entity.js';
import { ProjectMcpTool } from './project-mcp-tool.entity.js';

@Module({
    imports: [
        PassportModule.register({}),
        TypeOrmModule.forFeature([ProjectMcpServer, ProjectMcpTool, ProjectMcpAudit]),
        ExecutorModule,
        ProjectModule,
        UserModule
    ],
    controllers: [
        ProjectMcpController
    ],
    providers: [
        ProjectMcpService,
        ProjectMcpConnector,
        ProjectMcpMapper
    ],
    exports: [
        ProjectMcpService
    ]
})
export class ProjectMcpModule { }
