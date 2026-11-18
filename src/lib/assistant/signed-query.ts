// The OAuth provider sends a sender to the sign-in and consent pages with
// the assistant's authorization request in the query, signed: `sig` covers
// every parameter named in `ba_param`, and `exp` limits how long it holds.
// These helpers are shared by the browser and the server, so they import
// nothing.

const SIGNATURE_PARAM = "sig";
const SIGNED_NAMES_PARAM = "ba_param";

// Added by the provider when it signs, and not part of the assistant's own
// request.
const SIGNING_PARAMS = new Set([
  SIGNATURE_PARAM,
  SIGNED_NAMES_PARAM,
  "ba_iat",
  "ba_pl",
  "exp",
]);

/**
 * The signed part of a page's query, as the provider expects it back in
 * `oauth_query`: the parameters `ba_param` names, `ba_param` itself and
 * `sig`. Null when the query carries no signed request. This only picks the
 * parameters out; the server checks the signature.
 */
export function signedOAuthQuery(
  search: string | URLSearchParams,
): string | null {
  const params = new URLSearchParams(search);
  const signedNames = new Set(params.getAll(SIGNED_NAMES_PARAM));

  if (!params.has(SIGNATURE_PARAM) || signedNames.size === 0) {
    return null;
  }

  const signed = new URLSearchParams();

  for (const [key, value] of params) {
    if (
      key === SIGNATURE_PARAM ||
      key === SIGNED_NAMES_PARAM ||
      signedNames.has(key)
    ) {
      signed.append(key, value);
    }
  }

  return signed.toString();
}

/**
 * Where single sign-on returns to when the sign-in page was reached from an
 * assistant's authorization: the authorization request itself, so that the
 * provider picks it up again with the new session. Null when the page was
 * not reached that way.
 *
 * Single sign-on leaves the site for the identity provider and comes back
 * through a plain redirect, which carries no `oauth_query`. Asking again is
 * safe: the provider checks the request afresh, as it did the first time.
 */
export function ssoResumePath(search: string | URLSearchParams): string | null {
  const signed = signedOAuthQuery(search);

  if (!signed) {
    return null;
  }

  const request = new URLSearchParams();

  for (const [key, value] of new URLSearchParams(signed)) {
    if (!SIGNING_PARAMS.has(key)) {
      request.append(key, value);
    }
  }

  if (!request.has("client_id")) {
    return null;
  }

  // The sign-in that prompt=login asked for is the one just made. Left in,
  // it would send the sender back to the sign-in page, as the provider
  // itself drops it when a password sign-in picks the request up.
  const prompts = (request.get("prompt") ?? "")
    .split(" ")
    .filter((prompt) => prompt !== "" && prompt !== "login");

  if (prompts.length > 0) {
    request.set("prompt", prompts.join(" "));
  } else {
    request.delete("prompt");
  }

  return `/api/auth/oauth2/authorize?${request.toString()}`;
}

/**
 * Where the sign-in page may send someone on to after signing in, from its
 * `next` parameter: only a one-time upload link, as `/upload/<token>` and
 * nothing more (a token is base64url). Anything else, an absolute address,
 * `//host`, a backslash, an encoded form or any other path, is null, so the
 * parameter can't be used to send anyone elsewhere.
 */
export function uploadResumePath(
  search: string | URLSearchParams,
): string | null {
  const next = new URLSearchParams(search).get("next");

  return next !== null && /^\/upload\/[A-Za-z0-9_-]{1,128}$/.test(next)
    ? next
    : null;
}
