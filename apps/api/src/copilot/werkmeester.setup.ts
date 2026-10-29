import { Logger } from '@nestjs/common';

import type { UserService } from '../user/user.service.js';

import type { PlanSetup } from './copilot.mastra.js';
import { planConfig } from './werkmeester.config.js';

/**
 * Decides whether the Werkmeester is on: the environment must be valid (see planConfig) and PLAN_USER_EMAIL must resolve,
 * through UserService, to an existing bot user. Never creates a user and never throws: any problem is logged as a safe reason
 * (no secrets, no email) and the API starts without the Werkmeester.
 */
export async function resolvePlanSetup(users: Pick<UserService, 'findByEmail' | 'findIdentity'>, env: NodeJS.ProcessEnv = process.env, logger: Pick<Logger, 'log' | 'warn'> = new Logger('Werkmeester')): Promise<PlanSetup | null> {
    const config = planConfig(env);
    if (!config.enabled) {
        (env.PLAN_ENABLED?.trim() === 'true' ? logger.warn : logger.log).call(logger, `Werkmeester off: ${config.reason}.`);
        return null;
    }
    try {
        const user = await users.findByEmail(config.userEmail);
        if (!user) {
            logger.warn('Werkmeester off: PLAN_USER_EMAIL does not match an existing user (create the bot with the user:create CLI).');
            return null;
        }
        const identity = await users.findIdentity(user.id);
        if (!identity?.isBot) {
            logger.warn('Werkmeester off: PLAN_USER_EMAIL is not a bot user (mark it with the user:mark-bot CLI).');
            return null;
        }
        logger.log(`Werkmeester on (model ${config.model}, acting as user ${user.id}).`);
        return { config, user: { id: user.id, name: user.name, email: user.email } };
    } catch (error) {
        logger.warn(`Werkmeester off: the bot user could not be looked up (${error instanceof Error ? error.message : 'unknown error'}).`);
        return null;
    }
}
