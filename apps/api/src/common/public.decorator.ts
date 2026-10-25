import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opens a route (or controller) to requests without a JWT. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
