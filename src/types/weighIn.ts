export interface WeighInResponse {
    id: string;
    weight: number;
    loggedAt: string;
}

export interface CreateWeighInPayload {
    weight: number;
    loggedAt: string;
    /** The display unit the weight was entered in. Optional for older clients;
     *  the Coach engine falls back to the user's weight_unit. */
    unit?: 'lbs' | 'kg' | 'st';
}
