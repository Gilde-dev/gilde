import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import type { UserIdentityDto } from '../user/user.dto.js';

/**
 * Pure decision behind UserService.requireVerifiedHuman. `user` is the server-authenticated req.user; `persisted` is the
 * account freshly loaded by its id (null when deleted or not looked up). Accepts only a persisted non-bot human who
 * authenticated with a verified JWT; API keys (even of human accounts), bots and the scout account are refused.
 */
export function requireVerifiedHuman(
    user: AuthUser | undefined,
    persisted: UserIdentityDto | null,
    scoutEmail: string | undefined = process.env.SCOUT_USER_EMAIL,
): UserIdentityDto {
    if (!user?.id) throw new ForbiddenException('A verified human is required');
    if (user.credential !== 'jwt') throw new ForbiddenException('Sign in interactively; API keys cannot do this');
    if (!persisted || persisted.id !== user.id) throw new ForbiddenException('Account not found');
    if (persisted.isBot) throw new ForbiddenException('Bot accounts cannot do this');
    const scout = scoutEmail?.trim().toLowerCase();
    if (scout && persisted.email.trim().toLowerCase() === scout) throw new ForbiddenException('The scout account cannot do this');
    return persisted;
}
