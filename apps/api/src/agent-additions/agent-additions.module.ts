import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectModule } from '../project/project.module.js';
import { UserModule } from '../user/user.module.js';

import { AgentAdditionsController } from './agent-additions.controller.js';
import { AgentAdditionsService } from './agent-additions.service.js';
import { ProjectAgentInstructionVersion } from './project-agent-instruction-version.entity.js';
import { ProjectAgentInstruction } from './project-agent-instruction.entity.js';

/** Per-project additional instructions for Gilde's own agents (not the coding agents). */
@Module({
    imports: [TypeOrmModule.forFeature([ProjectAgentInstruction, ProjectAgentInstructionVersion]), PassportModule.register({}), ProjectModule, UserModule],
    controllers: [AgentAdditionsController],
    providers: [AgentAdditionsService],
    exports: [AgentAdditionsService],
})
export class AgentAdditionsModule { }
