import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';

import type { UserResponseDto } from '../user/user.dto.js';

import { AuthService } from './auth.service.js';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
    constructor(private readonly auth: AuthService) {
        super({ usernameField: 'email' });
    }

    validate(email: string, password: string): Promise<UserResponseDto> {
        return this.auth.validateCredentials(email, password);
    }
}
