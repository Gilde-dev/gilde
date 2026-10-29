import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentUsage } from '../otel/agent-usage.entity.js';

import { AgentRunCleanupService } from './agent-run-cleanup.service.js';
import { AgentRunController } from './agent-run.controller.js';
import { AgentRun } from './agent-run.entity.js';
import { AgentRunRecorder } from './agent-run.recorder.js';
import { AgentRunService } from './agent-run.service.js';
import { AgentToolCall } from './agent-tool-call.entity.js';

/** Global so the workers, the co-pilot, MCP and the dispatcher can record runs without importing each other. */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([AgentRun, AgentToolCall, AgentUsage])],
    controllers: [AgentRunController],
    providers: [AgentRunRecorder, AgentRunService, AgentRunCleanupService],
    exports: [AgentRunRecorder],
})
export class AgentRunModule { }
