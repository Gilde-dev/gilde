import { Module } from '@nestjs/common';

import { GitHubRestAdapter } from './github-rest.adapter.js';
import { GITHUB_PORT } from './github.port.js';

@Module({
    providers: [{ provide: GITHUB_PORT, useClass: GitHubRestAdapter }],
    exports: [GITHUB_PORT],
})
export class GitHubModule { }
