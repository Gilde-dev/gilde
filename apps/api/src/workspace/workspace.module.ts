import { Module } from '@nestjs/common';

import { RepoWorkspaceService } from './repo-workspace.service.js';

@Module({
    providers: [RepoWorkspaceService],
    exports: [RepoWorkspaceService],
})
export class WorkspaceModule { }
