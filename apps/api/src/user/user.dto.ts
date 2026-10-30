import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 12;

export const CreateUserSchema = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().max(255).pipe(z.email()),
    password: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`).max(1024),
});

export const UserResponseSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
});

/** Persisted identity used for human-only decisions; kept apart from UserResponseDto, which clients already rely on. */
export const UserIdentitySchema = z.object({
    id: z.string().uuid(),
    email: z.string(),
    isBot: z.boolean(),
    isAdmin: z.boolean().optional(),
    /** True when the account is deactivated. */
    deactivated: z.boolean().optional(),
});

/** Name, email and bot status of one account: what the agents page shows for a bot user. */
export const UserProfileSchema = UserResponseSchema.extend({ isBot: z.boolean() });

export type UserProfileDto = z.infer<typeof UserProfileSchema>;
export type CreateUserDto = z.infer<typeof CreateUserSchema>;
export type UserResponseDto = z.infer<typeof UserResponseSchema>;
export type UserIdentityDto = z.infer<typeof UserIdentitySchema>;

/** The signed-in user as GET /auth/me returns it. */
export const MeResponseSchema = UserResponseSchema.extend({ isAdmin: z.boolean() });
export type MeResponseDto = z.infer<typeof MeResponseSchema>;

export const InviteUserSchema = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().max(255).pipe(z.email()),
});
export type InviteUserDto = z.infer<typeof InviteUserSchema>;

export const SetAdminSchema = z.object({ isAdmin: z.boolean() });
export type SetAdminDto = z.infer<typeof SetAdminSchema>;

export const SetupPasswordSchema = z.object({
    token: z.string().min(1).max(200),
    password: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`).max(1024),
});
export type SetupPasswordDto = z.infer<typeof SetupPasswordSchema>;

/** One row of the admin user list; never any password data. */
export const AdminUserSchema = UserResponseSchema.extend({
    isBot: z.boolean(),
    isAdmin: z.boolean(),
    deactivatedAt: z.string().nullable(),
    createdAt: z.string(),
});
export type AdminUserDto = z.infer<typeof AdminUserSchema>;

/** A created or reset setup link. The link contains the plaintext token and is only ever returned here. */
export const SetupLinkSchema = z.object({
    user: AdminUserSchema,
    setupLink: z.string(),
    expiresAt: z.string(),
});
export type SetupLinkDto = z.infer<typeof SetupLinkSchema>;
