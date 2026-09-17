import { createWeaverError } from "../types/errors";
import type { JwtIdentity, JwtValidator } from "./jwt-validator";

export interface AuthMiddlewareOptions {
  jwtValidator: JwtValidator;
  /** Admin role names from the active generation's server.auth.adminRoles. */
  adminRoles?: string[];
}

export interface AuthContext {
  identity: JwtIdentity;
  isAdmin: boolean;
  isService: boolean;
  isUser: boolean;
}

export interface AuthMiddleware {
  /** Authenticate a request. Returns AuthContext or throws WeaverError */
  authenticate(token: string | undefined): Promise<AuthContext>;
  /** Check if context has admin access */
  requireAdmin(context: AuthContext): void;
  /** Extract token from transport headers */
  extractToken(headers: Record<string, string>): string | undefined;
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): AuthMiddleware {
  const adminRoles = new Set(options.adminRoles ?? ["admin"]);

  return {
    async authenticate(token: string | undefined): Promise<AuthContext> {
      if (!token) {
        throw createWeaverError("UNAUTHORIZED", "Authentication required");
      }

      const identity = await options.jwtValidator.validate(token);

      const isService = identity.serviceId !== undefined;
      const isUser = identity.userId !== undefined;
      const isAdmin =
        isService || (identity.roles?.some((r) => adminRoles.has(r)) ?? false);

      return { identity, isAdmin, isService, isUser };
    },

    requireAdmin(context: AuthContext): void {
      if (!context.isAdmin) {
        throw createWeaverError("FORBIDDEN", "Admin access required");
      }
    },

    extractToken(headers: Record<string, string>): string | undefined {
      const auth = headers.authorization ?? headers.Authorization;
      if (auth?.startsWith("Bearer ")) {
        return auth.slice(7);
      }
      return undefined;
    },
  };
}
