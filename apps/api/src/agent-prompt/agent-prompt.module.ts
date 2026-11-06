import { Module } from '@nestjs/common';

import { AgentAdditionsModule } from '../agent-additions/agent-additions.module.js';
import { CopilotCoreModule } from '../copilot/copilot.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { ProjectModule } from '../project/project.module.js';

import { AgentPromptController } from './agent-prompt.controller.js';
import { AgentPromptService } from './agent-prompt.service.js';

@Module({
    imports: [AgentAdditionsModule, CopilotCoreModule, ExecutionModule, ProjectModule],
    controllers: [AgentPromptController],
    providers: [AgentPromptService],
})
export class AgentPromptModule { }
