import { Logger } from '@nestjs/common';

import type { UserService } from '../user/user.service.js';

import type { RefineSetup } from './copilot.mastra.js';
import { refineConfig } from './verfijner.config.js';

/**
 * Decides whether the Verfijner is on: the environment must be valid (see refineConfig) and REFINE_USER_EMAIL must resolve,
 * through UserService, to an existing bot user. Never creates a user and never throws: any problem is logged as a safe reason
 * (no secrets, no email) and the API starts without the Verfijner, so intake items stay `new`.
 */
export async function resolveRefineSetup(users: Pick<UserService, 'findByEmail' | 'findIdentity'>, env: NodeJS.ProcessEnv = process.env, logger: Pick<Logger, 'log' | 'warn'> = new Logger('Verfijner')): Promise<RefineSetup | null> {
    const config = refineConfig(env);
    if (!config.enabled) {
        (env.REFINE_ENABLED?.trim() === 'true' ? logger.warn : logger.log).call(logger, `Verfijner off: ${config.reason}.`);
        return null;
    }
    try {
        const user = await users.findByEmail(config.userEmail);
        if (!user) {
            logger.warn('Verfijner off: REFINE_USER_EMAIL does not match an existing user (create the bot with the user:create CLI).');
            return null;
        }
        const identity = await users.findIdentity(user.id);
        if (!identity?.isBot) {
            logger.warn('Verfijner off: REFINE_USER_EMAIL is not a bot user (mark it with the user:mark-bot CLI).');
            return null;
        }
        logger.log(`Verfijner on (model ${config.model}, acting as user ${user.id}, ${config.dailyLimit} runs per project per day).`);
        return { config, user: { id: user.id, name: user.name, email: user.email } };
    } catch (error) {
        logger.warn(`Verfijner off: the bot user could not be looked up (${error instanceof Error ? error.message : 'unknown error'}).`);
        return null;
    }
}
