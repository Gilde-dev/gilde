import { Global, Logger, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserModule } from '../user/user.module.js';

import { AGENT_ENV, AGENTS_READY, AgentRuntimeService } from './agent-runtime.service.js';
import { AgentSettingsAudit } from './agent-settings-audit.entity.js';
import { AgentSettings } from './agent-settings.entity.js';
import { AgentSettingsService } from './agent-settings.service.js';
import { AgentController } from './agent.controller.js';
import { AgentMapper } from './agent.mapper.js';

/**
 * Runtime settings of the agents in the database (ADR 0017). Global because the workers, the dispatcher and the MCP
 * server all ask `AgentRuntimeService` what an agent is now.
 */
@Global()
@Module({
    imports: [PassportModule.register({}), TypeOrmModule.forFeature([AgentSettings, AgentSettingsAudit]), UserModule],
    controllers: [AgentController],
    providers: [
        { provide: AGENT_ENV, useValue: process.env },
        AgentRuntimeService,
        AgentSettingsService,
        AgentMapper,
        {
            // Seeds the missing records from the environment before anything that is built from the settings at startup.
            provide: AGENTS_READY,
            useFactory: async (settings: AgentSettingsService, runtime: AgentRuntimeService): Promise<true> => {
                await settings.seed().catch((error: unknown) => new Logger('Agents').error(`Seeding the agent settings failed: ${error instanceof Error ? error.message : 'unknown error'}`));
                await runtime.refreshAll();
                return true;
            },
            inject: [AgentSettingsService, AgentRuntimeService],
        },
    ],
    exports: [AgentRuntimeService, AgentSettingsService, AGENT_ENV, AGENTS_READY],
})
export class AgentModule { }
