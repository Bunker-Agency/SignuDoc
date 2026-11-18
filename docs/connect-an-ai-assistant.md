# Connect an AI assistant

An AI assistant such as Claude can prepare drafts in SignuDoc for you. It starts a draft, sets who signs, and puts the signature fields in place. You then review the draft in SignuDoc and press Send yourself. An assistant can never send anything.

This is off until an administrator turns it on. Nothing about it is reachable on a site where it is off.

> **Not yet checked live.** The connect flow is tested end to end in a browser with a stand-in assistant. It has not yet been tried against claude.ai or Claude Desktop, so those steps may need small adjustments. Claude Code and any other client that follows the MCP standard for sign-in should work as described.

## Turn it on (administrators)

1. Open Settings, then Organization, and find **AI assistant connections**.
2. Press **Turn on assistant connections**.

The change is recorded in the site audit trail. Turning it off again ends every connection at once.

## Add SignuDoc to your assistant

Use your site's address followed by `/api/mcp`, for example `https://sign.example.com/api/mcp`.

- **claude.ai:** Settings, Connectors, add a custom connector, and paste the address.
- **Claude Desktop:** Settings, Connectors, add a custom connector, and paste the address.
- **Claude Code:** run

  ```
  claude mcp add --transport http signudoc https://sign.example.com/api/mcp
  ```

  then run `/mcp` inside Claude Code and choose to sign in.

Your assistant opens SignuDoc in your browser. Sign in as usual (with your password, single sign-on, and your two-step code if you use one). SignuDoc then shows who is asking, as it describes itself, and what it will be allowed to do. Press **Approve**. This screen appears every time an assistant connects, even one you have approved before.

The assistant needs your email address to be verified. If your administrator requires two-step sign-in and you haven't set it up, SignuDoc asks you to do that first.

## What the assistant can and can't do

It can:

- see your own envelopes and their status, and read the text of your drafts (the `envelopes:read` permission);
- start a draft, set its signers and copy recipients, place fields, and delete a draft (the `drafts:write` permission).

It can't:

- send, remind, void or change an envelope that has been sent;
- email anyone;
- see anyone else's envelopes: it acts only as you.

You press Send in SignuDoc, after looking at the draft. Everything that applies to a send still applies: signer checks, signature meanings and, in Part 11 mode, identity confirmation.

A draft made this way records in its audit trail that it came from an assistant, with the assistant's name.

## Getting the PDF in: the upload link

An assistant can't pass a file through the connection. So when it starts a draft it gets a one-time upload link and gives it to you.

- Open the link. If you aren't signed in, sign in first, as the same person who approved the assistant. Then drop the PDF on the page.
- The link works once and expires after 30 minutes.
- An assistant that can run commands, such as Claude Code, can instead send the PDF to the link's API address itself, using the link alone. That works only while the assistant is still connected. On Vercel the file can be 4.5 MB at most this way.

Treat the link like a password until you have used it.

## Placing fields by text

The assistant reads the words on each page and puts a field next to a label, for example a signature to the right of "Signature:". It uses the same default field sizes as the prepare page.

- This needs a PDF with a text layer. A scanned PDF has none, and the assistant will say so. Then place the fields yourself on the prepare page.
- Placing fields **replaces every field already on the draft**. Setting signers keeps the fields of a signer whose email stays the same.
- If any label can't be found, nothing is placed and the problems are listed.

Always open the prepare page and check the fields before you send.

## Revoke a connection

Under Settings, **Connected apps** lists each assistant you have connected, when you connected it, and when it last used the connection. Press **Revoke** and it stops working straight away. Its access tokens stop at once.

Connections also end by themselves when:

- you reset your password;
- you choose "sign out everywhere" or "sign out everywhere else", or change your password with the option to sign out other devices;
- an administrator resets your two-step sign-in;
- your account is purged;
- the install's session limits are reached (see below);
- an administrator turns assistant connections off.

Changing your password alone, without signing out other devices, keeps your connections.

## Session limits

An assistant's access tokens last 1 hour and are renewed in the background, for up to 30 days. If your administrator has set session limits (Settings, Organization, Sign-in security), they apply to a connection as they do to your own sessions: an assistant left unused longer than the idle limit, or connected longer than the maximum session length, is disconnected and has to be approved again. A connection never outlives the install's limits.

## For administrators and self-hosters

- **Before you update:** run the database migrations before serving the new code. Password reset, sign-out everywhere and the administrator's two-step reset now touch new tables on every install, whether this feature is on or off. On Vercel the build does this by itself; on other hosts run `npm run db:migrate`.
- **Discovery:** assistants find the server at `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server/api/auth` (issuer `<your site>/api/auth`). Both return 404 while the setting is off. Registration, authorization and token requests are refused too.
- **Scopes:** `envelopes:read` and `drafts:write`, plus `offline_access` for refresh tokens. There is no `openid`. The `client_credentials` grant is not available: a client with no person behind it can't get a token.
- **Redirects:** an assistant can register `https:` redirect addresses, or `http:` ones on `localhost`, `127.0.0.1` or `[::1]`.
- **Known gap:** assistants register themselves, limited to 10 registrations an hour per address. That limit comes from Better Auth's own rate limiter, which is only active in production, so a local development server doesn't enforce it.
- **Compliance:** see [Part 11](part11/requirements.md) (SYS-11, SYS-12) and the [SOC 2 control map](soc2/control-map.md) (CC6.1, CC6.2). Deciding whether to turn this on is your decision to make and to record.
