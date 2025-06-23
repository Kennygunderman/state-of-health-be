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