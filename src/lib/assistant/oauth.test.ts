import assert from "node:assert/strict";
import { test } from "node:test";

import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";

import {
  ASSISTANT_SCOPES,
  buildOAuthProviderOptions,
  classifyOAuthPath,
  isAllowedRedirectUri,
  isDiscoveryPath,
} from "./oauth.ts";

const env = {
  APP_URL: "https://sign.acme.com/",
  BETTER_AUTH_URL: "https://sign.acme.com",
};

test("redirect URIs: https anywhere, http only on this machine", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:33418/callback",
    "http://127.0.0.1:5000/cb",
    "http://[::1]:5000/cb",
  ]) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
  }
});

test("redirect URIs: everything else is refused", () => {
  for (const uri of [
    "http://example.com/cb",
    "javascript:alert(1)",
    "custom-scheme://x",
    "http://localhost.evil.com/cb",
    "com.example.app:/cb",
    "data:text/html,hi",
    "file:///etc/passwd",
    "https://",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedRedirectUri(uri), false, uri);
  }
});

test("OAuth path: the endpoints an assistant needs are allowed", () => {
  for (const path of [
    "/oauth2/register",
    "/oauth2/authorize",
    "/oauth2/token",
    "/oauth2/consent",
    "/oauth2/continue",
    "/oauth2/public-client",
    "/oauth2/revoke",
    "/oauth2/introspect",
    "/oauth2/userinfo",
  ]) {
    assert.equal(classifyOAuthPath(path), "allowed", path);
  }
});

test("OAuth path: client and consent management are blocked", () => {
  for (const path of [
    "/oauth2/create-client",
    "/oauth2/get-client",
    "/oauth2/get-clients",
    "/oauth2/update-client",
    "/oauth2/delete-client",
    "/oauth2/client/rotate-secret",
    "/oauth2/client/rotate-keys",
    "/oauth2/get-consent",
    "/oauth2/get-consents",
    "/oauth2/update-consent",
    "/oauth2/delete-consent",
    "/oauth2/end-session",
    "/oauth2/end-session/confirm",
    "/oauth2/public-client-prelogin",
    "/oauth2/something-new",
    "/oauth2/",
    "/oauth2",
    // The jwt plugin's session token, which sits outside /oauth2/.
    "/token",
  ]) {
    assert.equal(classifyOAuthPath(path), "blocked", path);
  }
});

test("OAuth path: the rest of the auth API is not OAuth", () => {
  for (const path of [
    "/sign-in/email",
    "/get-session",
    "/jwks",
    "/two-factor/verify-totp",
    "/tokens",
    "/admin/oauth2/create-client",
  ]) {
    assert.equal(classifyOAuthPath(path), "not_oauth", path);
  }
});

// The allow-list above only means something if it covers every path the
// plugins really serve. This table is every one of them: a new path in an
// upgrade fails here until it has been looked at and classified.
const EXPECTED_ENDPOINTS: Record<
  string,
  ReturnType<typeof classifyOAuthPath>
> = {
  "/.well-known/oauth-authorization-server": "not_oauth",
  "/.well-known/openid-configuration": "not_oauth",
  "/admin/oauth2/create-client": "not_oauth",
  "/admin/oauth2/resources": "not_oauth",
  "/admin/oauth2/resources/:identifier": "not_oauth",
  "/admin/oauth2/resources/:identifier/clients/:client_id": "not_oauth",
  "/admin/oauth2/update-client": "not_oauth",
  "/jwks": "not_oauth",
  "/oauth2/authorize": "allowed",
  "/oauth2/client/rotate-keys": "blocked",
  "/oauth2/client/rotate-secret": "blocked",
  "/oauth2/consent": "allowed",
  "/oauth2/continue": "allowed",
  "/oauth2/create-client": "blocked",
  "/oauth2/delete-client": "blocked",
  "/oauth2/delete-consent": "blocked",
  "/oauth2/end-session": "blocked",
  "/oauth2/end-session/confirm": "blocked",
  "/oauth2/get-client": "blocked",
  "/oauth2/get-clients": "blocked",
  "/oauth2/get-consent": "blocked",
  "/oauth2/get-consents": "blocked",
  "/oauth2/introspect": "allowed",
  "/oauth2/public-client": "allowed",
  "/oauth2/public-client-prelogin": "blocked",
  "/oauth2/register": "allowed",
  "/oauth2/revoke": "allowed",
  "/oauth2/token": "allowed",
  "/oauth2/update-client": "blocked",
  "/oauth2/update-consent": "blocked",
  "/oauth2/userinfo": "allowed",
  "/token": "blocked",
};

test("OAuth path: every endpoint the plugins add is classified as expected", () => {
  const endpoints = {
    ...oauthProvider(buildOAuthProviderOptions(env)).endpoints,
    ...jwt({ disableSettingJwtHeader: true }).endpoints,
  };
  // A path served for several methods is listed once.
  const paths = [
    ...new Set(
      Object.values(endpoints)
        .map((endpoint) => (endpoint as { path?: string }).path)
        .filter((path): path is string => typeof path === "string"),
    ),
  ].sort();

  assert.deepEqual(paths, Object.keys(EXPECTED_ENDPOINTS).sort());

  for (const path of paths) {
    assert.equal(classifyOAuthPath(path), EXPECTED_ENDPOINTS[path], path);
  }
});

test("discovery paths are recognised wherever the handler may serve them", () => {
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/.well-known/oauth-authorization-server",
    "/api/auth/.well-known/openid-configuration",
    "/.well-known/openid-configuration/api/auth",
  ]) {
    assert.equal(isDiscoveryPath(path), true, path);
  }

  for (const path of ["/api/auth/oauth2/token", "/api/auth/jwks", "/"]) {
    assert.equal(isDiscoveryPath(path), false, path);
  }
});

test("the provider grants only the assistant scopes and a refresh token", () => {
  const options = buildOAuthProviderOptions(env);

  assert.deepEqual(ASSISTANT_SCOPES, ["envelopes:read", "drafts:write"]);
  assert.deepEqual(options.scopes, [
    "envelopes:read",
    "drafts:write",
    "offline_access",
  ]);
  assert.deepEqual(options.clientRegistrationDefaultScopes, [
    "envelopes:read",
    "drafts:write",
    "offline_access",
  ]);
  assert.deepEqual(options.resources, ["https://sign.acme.com/api/mcp"]);
  assert.equal(options.enforcePerClientResources, false);
  assert.equal(options.clientRegistrationDefaultApplicationType, "infer");
  assert.equal(options.allowDynamicClientRegistration, true);
  assert.equal(options.allowUnauthenticatedClientRegistration, true);
  assert.equal(options.loginPage, "/login");
  assert.equal(options.consentPage, "/oauth/consent");
  assert.deepEqual(options.rateLimit?.register, { max: 10, window: 3600 });
  assert.deepEqual(options.grantTypes, ["authorization_code", "refresh_token"]);
});
