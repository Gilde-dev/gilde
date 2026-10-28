import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { GitHubCredentials } from '../github/github-credentials.js';
import { GithubInstallation } from './github-installation.entity.js';

export interface AppStatus {
    /** Null when no installation event has been seen for the repo. */
    installed: boolean | null;
    /** Set when app mode is active and the app is known not to be installed. */
    warning: string | null;
}

@Injectable()
export class GithubInstallationService {
    constructor(
        @InjectRepository(GithubInstallation) private readonly installs: Repository<GithubInstallation>,
        private readonly credentials: GitHubCredentials,
    ) { }

    /** Records installed/removed for repos by full name (any case). */
    async record(fullNames: string[], installed: boolean): Promise<void> {
        for (const name of fullNames) {
            await this.installs.save({ fullName: name.toLowerCase(), installed });
        }
    }

    async statusFor(fullNames: string[]): Promise<Map<string, AppStatus>> {
        const rows = fullNames.length ? await this.installs.findBy({ fullName: In(fullNames) }) : [];
        const known = new Map(rows.map((r) => [r.fullName, r.installed]));
        const app = this.credentials.mode === 'app';
        return new Map(fullNames.map((n) => {
            const installed = known.get(n) ?? null;
            return [n, {
                installed,
                warning: app && installed === false ? `The Gilde GitHub App is no longer installed on ${n}; Gilde cannot read it.` : null,
            }];
        }));
    }
}
