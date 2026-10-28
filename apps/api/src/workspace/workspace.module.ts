import { Module } from '@nestjs/common';

import { GitHubModule } from '../github/github.module.js';
import { RepoWorkspaceService } from './repo-workspace.service.js';

@Module({
    imports: [GitHubModule],
    providers: [RepoWorkspaceService],
    exports: [RepoWorkspaceService],
})
export class WorkspaceModule { }
