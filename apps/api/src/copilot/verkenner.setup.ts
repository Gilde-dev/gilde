import { Logger } from '@nestjs/common';

import type { UserService } from '../user/user.service.js';

import type { ScoutSetup } from './copilot.mastra.js';
import { scoutConfig } from './verkenner.config.js';

/**
 * Decides whether the scout is on: the environment must be valid (see scoutConfig) and SCOUT_USER_EMAIL must resolve,
 * through UserService, to an existing user. Never creates a user and never throws: any problem is logged as a safe
 * reason (no secrets, no email) and the API starts without the scout.
 */
export async function resolveScoutSetup(users: Pick<UserService, 'findByEmail'>, env: NodeJS.ProcessEnv = process.env, logger: Pick<Logger, 'log' | 'warn'> = new Logger('Verkenner')): Promise<ScoutSetup | null> {
    const config = scoutConfig(env);
    if (!config.enabled) {
        // Unset is the normal state: an info line. A flag that is set but cannot work deserves a warning.
        (env.SCOUT_ENABLED?.trim() === 'true' ? logger.warn : logger.log).call(logger, `Scout off: ${config.reason}.`);
        return null;
    }
    try {
        const user = await users.findByEmail(config.userEmail);
        if (!user) {
            logger.warn('Scout off: SCOUT_USER_EMAIL does not match an existing user (create the bot with the user:create CLI).');
            return null;
        }
        logger.log(`Scout on (model ${config.model}, acting as user ${user.id}).`);
        return { config, user: { id: user.id, name: user.name, email: user.email } };
    } catch (error) {
        logger.warn(`Scout off: the scout user could not be looked up (${error instanceof Error ? error.message : 'unknown error'}).`);
        return null;
    }
}
