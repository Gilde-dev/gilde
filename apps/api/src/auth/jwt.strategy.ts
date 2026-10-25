import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { jwtSecret } from './auth.config.js';
import type { AuthUser, JwtPayload } from './auth.dto.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: jwtSecret(),
            algorithms: ['HS256'],
            ignoreExpiration: false,
        });
    }

    validate(payload: JwtPayload): AuthUser {
        return { id: payload.sub, name: payload.name, email: payload.email };
    }
}
