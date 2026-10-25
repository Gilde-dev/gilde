import { z } from 'zod';

import { UserResponseSchema } from '../user/user.dto.js';

export const LoginResponseSchema = z.object({
    accessToken: z.string(),
    expiresIn: z.number().int(),
    user: UserResponseSchema,
});

export type LoginResponseDto = z.infer<typeof LoginResponseSchema>;

export interface JwtPayload {
    sub: string;
    email: string;
    name: string;
}

/** The authenticated user as attached to the request. */
export interface AuthUser {
    id: string;
    name: string;
    email: string;
}
