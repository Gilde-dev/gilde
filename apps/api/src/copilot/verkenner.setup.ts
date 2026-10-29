import { Logger } from '@nestjs/common';

import type { UserService } from '../user/user.service.js';

import type { ScoutSetup } from './copilot.mastra.js';
import { scoutConfig } from './verkenner.config.js';

export interface ScoutState {
    setup: ScoutSetup | null;
    /** Why the scout is off although SCOUT_ENABLED=true; null when it is on or was never switched on. */
    disabledReason: string | null;
}

/**
 * Decides whether the scout is on: the environment must be valid (see scoutConfig) and SCOUT_USER_EMAIL must resolve,
 * through UserService, to an existing bot user (like the Verfijner: a non-bot account would own the jobs it suggests, and
 * dispatch waits for an executor of that owner). Never creates a user and never throws: any problem is logged and returned
 * as `disabledReason`, and the API starts without the scout. Reasons never contain secrets.
 */
export async function resolveScoutState(users: Pick<UserService, 'findByEmail' | 'findIdentity'>, env: NodeJS.ProcessEnv = process.env, logger: Pick<Logger, 'log' | 'warn' | 'error'> = new Logger('Verkenner')): Promise<ScoutState> {
    const config = scoutConfig(env);
    if (!config.enabled) {
        // Unset is the normal state: an info line. A flag that is set but cannot work deserves a warning.
        if (env.SCOUT_ENABLED?.trim() !== 'true') {
            logger.log(`Scout off: ${config.reason}.`);
            return { setup: null, disabledReason: null };
        }
        logger.warn(`Scout off: ${config.reason}.`);
        return { setup: null, disabledReason: config.reason };
    }
    const off = (reason: string): ScoutState => {
        logger.error(`Verkenner disabled: ${reason}`);
        return { setup: null, disabledReason: reason };
    };
    try {
        const user = await users.findByEmail(config.userEmail);
        if (!user) return off(`SCOUT_USER_EMAIL ${config.userEmail} does not exist; create it with \`user:create --email ${config.userEmail} --bot\` and restart`);
        const identity = await users.findIdentity(user.id);
        if (!identity?.isBot) return off(`SCOUT_USER_EMAIL ${config.userEmail} is not a bot account; mark it with \`user:mark-bot --email ${config.userEmail}\` and restart`);
        logger.log(`Scout on (model ${config.model}, acting as user ${user.id}).`);
        return { setup: { config, user: { id: user.id, name: user.name, email: user.email } }, disabledReason: null };
    } catch (error) {
        return off(`the scout user could not be looked up (${error instanceof Error ? error.message : 'unknown error'})`);
    }
}

export async function resolveScoutSetup(users: Pick<UserService, 'findByEmail' | 'findIdentity'>, env: NodeJS.ProcessEnv = process.env, logger?: Pick<Logger, 'log' | 'warn' | 'error'>): Promise<ScoutSetup | null> {
    return (await resolveScoutState(users, env, logger)).setup;
}
