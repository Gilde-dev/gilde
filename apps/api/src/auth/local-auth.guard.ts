import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { INVALID_CREDENTIALS } from './auth.service.js';

@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {
    // Missing fields and wrong credentials give the same 401.
    handleRequest<T>(err: unknown, user: T | false): T {
        if (err instanceof UnauthorizedException) throw err;
        if (err || !user) throw new UnauthorizedException(INVALID_CREDENTIALS);
        return user;
    }
}
