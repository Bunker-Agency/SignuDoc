import assert from "node:assert/strict";
import { test } from "node:test";

import { signedOAuthQuery, ssoResumePath } from "./signed-query.ts";

// What the provider puts on /login and /oauth/consent: the request, the
// signing fields, and every signed name listed in ba_param.
const SIGNED =
  "response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A33418%2Fcallback" +
  "&scope=envelopes%3Aread+drafts%3Awrite&state=s1&resource=http%3A%2F%2Flocalhost%3A3998%2Fapi%2Fmcp" +
  "&code_challenge=xyz&code_challenge_method=S256&exp=1900000000&ba_iat=1800000000000" +
  "&ba_param=ba_iat&ba_param=ba_param&ba_param=client_id&ba_param=code_challenge" +
  "&ba_param=code_challenge_method&ba_param=exp&ba_param=redirect_uri&ba_param=resource" +
  "&ba_param=response_type&ba_param=scope&ba_param=state&sig=SIGNATURE";

test("the signed query keeps only what was signed", () => {
  const withExtras = `${SIGNED}&error=access_denied&utm_source=x`;

  assert.equal(signedOAuthQuery(withExtras), SIGNED);
  assert.equal(signedOAuthQuery(`?${SIGNED}`), SIGNED);
});

test("a query without a signature is not a signed query", () => {
  assert.equal(signedOAuthQuery(""), null);
  assert.equal(signedOAuthQuery("error=access_denied"), null);
  assert.equal(signedOAuthQuery("client_id=abc&sig=x"), null);
});

test("single sign-on returns to the authorization request without its signature", () => {
  const path = ssoResumePath(`?${SIGNED}&error=x`);

  assert.ok(path);

  const url = new URL(path, "http://localhost:3998");

  assert.equal(url.pathname, "/api/auth/oauth2/authorize");
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "redirect_uri",
    "resource",
    "response_type",
    "scope",
    "state",
  ]);
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:33418/callback",
  );
});

test("single sign-on from a plain sign-in page goes where it always did", () => {
  assert.equal(ssoResumePath(""), null);
  assert.equal(ssoResumePath("?error=access_denied"), null);
});

test("single sign-on doesn't ask for the sign-in it has just made", () => {
  const withPrompt = (prompt: string) =>
    new URL(
      ssoResumePath(
        `?${SIGNED.replace("&sig=", `&prompt=${encodeURIComponent(prompt)}&ba_param=prompt&sig=`)}`,
      ) ?? "",
      "http://localhost:3998",
    ).searchParams.get("prompt");

  assert.equal(withPrompt("login"), null);
  assert.equal(withPrompt("login consent"), "consent");
  assert.equal(withPrompt("consent"), "consent");
});
