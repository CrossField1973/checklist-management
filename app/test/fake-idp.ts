import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface IdpUser { sub: string; email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string }
export interface IdpBehaviour {
  /** Überschreibt Werte im ID-Token, um Fehlerfälle zu simulieren */
  nonce?: string;
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  /** Anbieter lehnt die Anmeldung ab (error=access_denied) */
  deny?: boolean;
  /** Token-Endpunkt antwortet mit Fehler */
  tokenError?: boolean;
}

/**
 * Minimaler OpenID-Connect-Anbieter für Tests: Discovery, Autorisierung (mit PKCE-Prüfung), Token-Endpunkt
 * (einmalig verwendbare Codes, Client-Authentifizierung) und JWKS. Echte HTTP-Anfragen, echte RS256-Signaturen.
 */
export async function startFakeIdp(clientId = "checklisten", clientSecret = "geheimnis") {
  const app = Fastify();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; user: IdpUser; behaviour: IdpBehaviour }>();
  const state = { user: { sub: "sub-1", email: "anna@example.org", email_verified: true, name: "Anna Muster" } as IdpUser, behaviour: {} as IdpBehaviour };
  const authorizeRequests: URLSearchParams[] = [];
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  let issuer = ""; // wird nach dem Start gesetzt; die Handler lesen ihn erst bei Anfragen

  app.get("/.well-known/openid-configuration", async () => ({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"], code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email", "profile"],
  }));
  app.get("/jwks", async () => ({ keys: [jwk] }));

  app.get("/authorize", async (req, reply) => {
    const q = new URLSearchParams(req.query as Record<string, string>);
    authorizeRequests.push(q);
    const redirect = new URL(q.get("redirect_uri")!);
    if (q.get("response_type") !== "code" || q.get("client_id") !== clientId || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state") || !q.get("nonce")) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    redirect.searchParams.set("state", q.get("state")!);
    if (state.behaviour.deny) {
      redirect.searchParams.set("error", "access_denied");
    } else {
      const code = randomUUID();
      codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, user: { ...state.user }, behaviour: { ...state.behaviour } });
      redirect.searchParams.set("code", code);
    }
    return reply.redirect(redirect.href, 302);
  });

  app.post("/token", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
    const [id, secret] = basic ? Buffer.from(basic[1]!, "base64").toString().split(":") : [body.client_id, body.client_secret];
    if (id !== clientId || secret !== clientSecret) return reply.code(401).send({ error: "invalid_client" });
    const entry = codes.get(body.code ?? "");
    codes.delete(body.code ?? ""); // Codes sind nur einmal verwendbar
    if (state.behaviour.tokenError || !entry || body.grant_type !== "authorization_code" || body.redirect_uri !== entry.redirectUri) {
      return reply.code(400).send({ error: "invalid_grant" });
    }
    const challenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
    if (challenge !== entry.challenge) return reply.code(400).send({ error: "invalid_grant", error_description: "PKCE" });
    const b = entry.behaviour;
    const { sub, ...claims } = entry.user;
    const idToken = await new SignJWT({ ...claims, nonce: b.nonce ?? entry.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(b.issuer ?? issuer).setAudience(b.audience ?? clientId).setSubject(sub)
      .setIssuedAt().setExpirationTime(`${b.expiresInSeconds ?? 300}s`)
      .sign(privateKey);
    return { access_token: "at-" + randomUUID(), token_type: "Bearer", expires_in: 300, id_token: idToken };
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  issuer = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  return {
    issuer, clientId, clientSecret, authorizeRequests,
    setUser: (u: IdpUser) => { state.user = u; },
    setBehaviour: (b: IdpBehaviour) => { state.behaviour = b; },
    close: () => app.close(),
  };
}

export type FakeIdp = Awaited<ReturnType<typeof startFakeIdp>>;
