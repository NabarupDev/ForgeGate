export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tenantId: string;
  iat?: number;
  exp?: number;
}

export interface UserContext {
  id: string;
  email: string;
  role: string;
  tenantId: string;
}
