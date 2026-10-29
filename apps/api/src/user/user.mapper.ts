import { Injectable } from "@nestjs/common";
import { User } from "./user.entity.js";
import type { UserIdentityDto, UserProfileDto, UserResponseDto } from "./user.dto.js";

@Injectable()
export class UserMapper {

    toDTO(entity: User): UserResponseDto {
        return {
            id: entity.id,
            name: entity.name,
            email: entity.email,
        }
    }

    toProfileDTO(entity: User): UserProfileDto {
        return { id: entity.id, name: entity.name, email: entity.email, isBot: entity.isBot };
    }

    toIdentityDTO(entity: User): UserIdentityDto {
        return { id: entity.id, email: entity.email, isBot: entity.isBot };
    }
}
