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

/** How the request authenticated. Set by the server only after a successful JWT or API-key check. */
export type CredentialKind = 'jwt' | 'api_key';

/** The authenticated user as attached to the request. */
export interface AuthUser {
    id: string;
    name: string;
    email: string;
    /** Trusted provenance; never read from a token payload, header or body. */
    credential?: CredentialKind;
}
