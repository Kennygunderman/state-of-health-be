export interface CreateUserRequest {
    userId: string;
    email: string;
    firstName?: string;
    lastName?: string;
}

export interface UserResponse {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
}

export interface UpdateAvatarRequest {
    avatarBase64: string | null;
}

export interface AvatarResponse {
    avatarBase64: string | null;
} 