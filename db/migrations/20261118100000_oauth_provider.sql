-- The tables for SignuDoc as an OAuth authorization server for AI assistants
-- (src/lib/assistant/oauth.ts), from `npm run auth:generate` with
-- @better-auth/oauth-provider 1.7.25 and Better Auth's jwt plugin. New tables
-- only; no existing table is changed. Names are camelCase and quoted, like
-- the other Better Auth tables.
--
-- * jwks: the keys access tokens are signed with.
-- * oauthClient: assistants that registered themselves.
-- * oauthResource, oauthClientResource: the MCP endpoint as the one resource
--   tokens are issued for.
-- * oauthRefreshToken, oauthAccessToken: refresh tokens, and opaque access
--   tokens (JWT access tokens are not stored).
-- * oauthConsent: what a sender approved for an assistant.
-- * oauthClientAssertion: single-use client assertions.

create table if not exists public."jwks" (
  "id" text not null primary key,
  "publicKey" text not null,
  "privateKey" text not null,
  "createdAt" timestamptz not null,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

create table if not exists public."oauthClient" (
  "id" text not null primary key,
  "clientId" text not null unique,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb,
  "userId" text references public."user" ("id") on delete cascade,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb not null,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean,
  "referenceId" text,
  "metadata" jsonb
);

create table if not exists public."oauthResource" (
  "id" text not null primary key,
  "identifier" text not null unique,
  "name" text not null,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean,
  "disabled" boolean,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer,
  "metadata" jsonb
);

create table if not exists public."oauthClientResource" (
  "id" text not null primary key,
  "clientId" text not null references public."oauthClient" ("clientId") on delete cascade,
  "resourceId" text not null references public."oauthResource" ("identifier") on delete cascade,
  "metadata" jsonb,
  "createdAt" timestamptz
);

create table if not exists public."oauthRefreshToken" (
  "id" text not null primary key,
  "token" text not null unique,
  "clientId" text not null references public."oauthClient" ("clientId") on delete cascade,
  "sessionId" text references public.session ("id") on delete set null,
  "userId" text not null references public."user" ("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb not null
);

create table if not exists public."oauthAccessToken" (
  "id" text not null primary key,
  "token" text not null unique,
  "clientId" text not null references public."oauthClient" ("clientId") on delete cascade,
  "sessionId" text references public.session ("id") on delete set null,
  "userId" text references public."user" ("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" text references public."oauthRefreshToken" ("id") on delete cascade,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb not null
);

create table if not exists public."oauthConsent" (
  "id" text not null primary key,
  "clientId" text not null references public."oauthClient" ("clientId") on delete cascade,
  "userId" text references public."user" ("id") on delete cascade,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);

create table if not exists public."oauthClientAssertion" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null
);

create index if not exists "oauthClient_userId_idx" on public."oauthClient" ("userId");

create index if not exists "oauthClientResource_clientId_idx" on public."oauthClientResource" ("clientId");

create index if not exists "oauthClientResource_resourceId_idx" on public."oauthClientResource" ("resourceId");

create index if not exists "oauthRefreshToken_clientId_idx" on public."oauthRefreshToken" ("clientId");

create index if not exists "oauthRefreshToken_sessionId_idx" on public."oauthRefreshToken" ("sessionId");

create index if not exists "oauthRefreshToken_userId_idx" on public."oauthRefreshToken" ("userId");

create index if not exists "oauthRefreshToken_authorizationCodeId_idx" on public."oauthRefreshToken" ("authorizationCodeId");

create index if not exists "oauthAccessToken_clientId_idx" on public."oauthAccessToken" ("clientId");

create index if not exists "oauthAccessToken_sessionId_idx" on public."oauthAccessToken" ("sessionId");

create index if not exists "oauthAccessToken_userId_idx" on public."oauthAccessToken" ("userId");

create index if not exists "oauthAccessToken_authorizationCodeId_idx" on public."oauthAccessToken" ("authorizationCodeId");

create index if not exists "oauthAccessToken_refreshId_idx" on public."oauthAccessToken" ("refreshId");

create index if not exists "oauthConsent_clientId_idx" on public."oauthConsent" ("clientId");

create index if not exists "oauthConsent_userId_idx" on public."oauthConsent" ("userId");

create unique index if not exists "oauthClientResource_clientId_resourceId_uidx" on public."oauthClientResource" ("clientId", "resourceId");
