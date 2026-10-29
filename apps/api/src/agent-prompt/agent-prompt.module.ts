import { Module } from '@nestjs/common';

import { CopilotCoreModule } from '../copilot/copilot.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { ProjectModule } from '../project/project.module.js';

import { AgentPromptController } from './agent-prompt.controller.js';
import { AgentPromptService } from './agent-prompt.service.js';

@Module({
    imports: [CopilotCoreModule, ExecutionModule, ProjectModule],
    controllers: [AgentPromptController],
    providers: [AgentPromptService],
})
export class AgentPromptModule { }
