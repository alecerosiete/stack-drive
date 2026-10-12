/** Payload del access token de StackDrive (no confundir con los de Google). */
export interface JwtPayload {
  /** `user.id` del tenant. */
  sub: string;
  email: string;
  iat?: number;
  exp?: number;
}

/** Usuario autenticado tal y como queda adjunto a la petición. */
export interface AuthenticatedUser {
  id: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
