import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

// Same rules as stuntman-diet: Cognito RS256 tokens, issuer pinned to the pool,
// access or id token only, and a client id that matches this app (or the smoke client,
// which may only use the health-smoke/query scope).

export interface AuthConfig {
  userPool: string;
  clientId: string;
  smokeClientId?: string;
}

export interface VerifiedUser extends JWTPayload {
  sub: string;
}

export function poolIssuer(pool: string): string {
  if (pool.startsWith("https://")) return pool.replace(/\/$/, "");
  const match = /^([a-z0-9-]+)_[A-Za-z0-9]+$/.exec(pool);
  if (!match?.[1]) throw new Error("COGNITO_USER_POOL must be a User Pool ID or issuer URL");
  return `https://cognito-idp.${match[1]}.amazonaws.com/${pool}`;
}

const remoteSets = new Map<string, JWTVerifyGetKey>();

function remoteKeySet(issuer: string): JWTVerifyGetKey {
  let keys = remoteSets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    remoteSets.set(issuer, keys);
  }
  return keys;
}

/** Pure verification against a key set. Tests use a local key set; production uses the pool's JWKS. */
export async function verifyWithKeys(
  token: string,
  keys: JWTVerifyGetKey,
  config: AuthConfig,
): Promise<VerifiedUser> {
  const issuer = poolIssuer(config.userPool);
  const { payload } = await jwtVerify(token, keys, { issuer, algorithms: ["RS256"] });
  if (payload.token_use !== "access" && payload.token_use !== "id") {
    throw new errors.JWTClaimValidationFailed("Unexpected Cognito token type", payload, "token_use", "invalid");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new errors.JWTClaimValidationFailed("Cognito token is missing a subject", payload, "sub", "missing");
  }
  const isSmoke = Boolean(config.smokeClientId) && payload.token_use === "access" && payload.client_id === config.smokeClientId;
  if (isSmoke) {
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (!scopes.includes("health-smoke/query")) {
      throw new errors.JWTClaimValidationFailed("Smoke token is missing its required scope", payload, "scope", "missing");
    }
  } else if (
    (payload.token_use === "id" && payload.aud !== config.clientId) ||
    (payload.token_use === "access" && payload.client_id !== config.clientId)
  ) {
    throw new errors.JWTClaimValidationFailed("Cognito token was issued to a different app client", payload, "client_id", "invalid");
  }
  return { ...payload, sub: payload.sub };
}

export function verifyCognitoToken(token: string, config: AuthConfig): Promise<VerifiedUser> {
  return verifyWithKeys(token, remoteKeySet(poolIssuer(config.userPool)), config);
}
