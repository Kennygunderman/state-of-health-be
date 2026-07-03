export interface WeighInResponse {
    id: string;
    weight: number;
    loggedAt: string;
}

export interface CreateWeighInPayload {
    weight: number;
    loggedAt: string;
}
