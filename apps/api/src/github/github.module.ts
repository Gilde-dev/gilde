import { Module } from '@nestjs/common';

import { GitHubCredentials } from './github-credentials.js';
import { GitHubRestAdapter } from './github-rest.adapter.js';
import { GITHUB_PORT } from './github.port.js';

@Module({
    providers: [GitHubCredentials, { provide: GITHUB_PORT, useClass: GitHubRestAdapter }],
    exports: [GITHUB_PORT, GitHubCredentials],
})
export class GitHubModule { }
