import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, errors, type JWK, type KeyLike } from "jose";
import { poolIssuer, verifyWithKeys, type AuthConfig } from "../src/auth.js";

// Test pool and clients. Values are arbitrary but fixed, so expectations are written by hand.
const POOL = "eu-west-1_TESTPOOL";
const ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TESTPOOL";
const APP_CLIENT = "app-client-123";
const SMOKE_CLIENT = "smoke-client-456";
const config: AuthConfig = { userPool: POOL, clientId: APP_CLIENT, smokeClientId: SMOKE_CLIENT };

let privateKey: KeyLike;
let keys: ReturnType<typeof createLocalJWKSet>;
let otherPrivateKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [publicJwk] });
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
});

function sign(claims: Record<string, unknown>, key: KeyLike = privateKey, expiresIn = "1h"): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

const goodAccess = { token_use: "access", sub: "user-1", client_id: APP_CLIENT };

describe("poolIssuer", () => {
  it("builds the regional issuer URL from a pool ID", () => {
    expect(poolIssuer(POOL)).toBe(ISSUER);
  });
  it("keeps an issuer URL as it is, without a trailing slash", () => {
    expect(poolIssuer(`${ISSUER}/`)).toBe(ISSUER);
  });
  it("rejects a value that is neither a pool ID nor a URL", () => {
    expect(() => poolIssuer("not a pool")).toThrow("User Pool ID");
  });
});

describe("verifyWithKeys", () => {
  it("accepts an access token issued to the app client and returns its subject", async () => {
    const token = await sign(goodAccess);
    const user = await verifyWithKeys(token, keys, config);
    expect(user.sub).toBe("user-1");
  });

  it("accepts an id token whose audience is the app client", async () => {
    const token = await sign({ token_use: "id", sub: "user-2", aud: APP_CLIENT });
    expect((await verifyWithKeys(token, keys, config)).sub).toBe("user-2");
  });

  it("rejects an access token issued to a different app client", async () => {
    const token = await sign({ ...goodAccess, client_id: "someone-else" });
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  it("rejects an id token whose audience is a different app client", async () => {
    const token = await sign({ token_use: "id", sub: "user-3", aud: "someone-else" });
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  it("rejects a token of any other token_use", async () => {
    const token = await sign({ ...goodAccess, token_use: "refresh" });
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  it("rejects a token with no subject", async () => {
    const token = await sign({ token_use: "access", client_id: APP_CLIENT });
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  it("rejects a token from a different issuer", async () => {
    const token = await new SignJWT({ ...goodAccess })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_OTHER")
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  it("rejects an expired token", async () => {
    const token = await sign(goodAccess, privateKey, "-1h");
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it("rejects a token signed by a key that is not in the pool's key set", async () => {
    const token = await sign(goodAccess, otherPrivateKey);
    await expect(verifyWithKeys(token, keys, config)).rejects.toBeInstanceOf(errors.JOSEError);
  });

  it("accepts a smoke token only when it carries the health-smoke/query scope", async () => {
    const withScope = await sign({ token_use: "access", sub: "smoke", client_id: SMOKE_CLIENT, scope: "health-smoke/query" });
    expect((await verifyWithKeys(withScope, keys, config)).client_id).toBe(SMOKE_CLIENT);
  });

  it("rejects a smoke token that is missing the scope", async () => {
    const withoutScope = await sign({ token_use: "access", sub: "smoke", client_id: SMOKE_CLIENT, scope: "openid" });
    await expect(verifyWithKeys(withoutScope, keys, config)).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });
});
