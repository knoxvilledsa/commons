// GET and POST /api/unsubscribe?token=... - leaving one list.
//
// POST is the RFC 8058 one-click path. Every bulletin carries
//   List-Unsubscribe: <https://knoxvilledsa.org/api/unsubscribe?token=...>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
// and the mail provider POSTs that URL when someone presses the unsubscribe
// button in their mail client. It is a server to server request with no browser
// and no person watching, so it carries no Turnstile, no honeypot and no
// cookie, and it answers 200 with no body. The signed token is the only
// authentication, which is exactly what RFC 8058 intends.
//
// GET is the visible footer link. Same flip, then a redirect to the page.
// There is no "are you sure" step, on purpose: confirmation friction belongs on
// signup, not on leaving, and the action is reversible by signing up again.
//
// ONE LINK, ONE LIST. A token minted for Legislative Watch cannot unsubscribe
// anyone from News Watch, because _subscribe_token.js refuses to verify an
// unsub token that names anything other than exactly one list, and the Resend
// call is built only from that one signed slug. A Legislative Watch footer link
// structurally cannot reach another list.
//
// UNSUB TOKENS DO NOT EXPIRE, AND THAT IS DELIBERATE. A List-Unsubscribe header
// has to work whenever the message is found, including out of an archive years
// later. See UNSUB_TTL_S in _subscribe_token.js for the reasoning and for what
// revocation looks like.
//
// Replay is a non-issue here: opting the same address out of the same list
// twice is the same state. So there is no nonce burn and no single-use check,
// unlike confirm.js where a replay could resurrect a cancelled subscription.
//
// NO KV THROTTLE HERE, AND THAT IS A CONSIDERED CHOICE. subscribe.js throttles
// hard, because it can send mail. This endpoint cannot send anything; the worst
// a flood achieves is CPU. Two reasons not to count attempts in KV anyway:
//
//   - Throttling a VERIFIED token would only ever stop a real person from
//     leaving a list, and a blocked unsubscribe is a compliance problem, not a
//     saved request. Mail providers also one-click from many addresses, so a
//     per-IP rule would misfire on exactly the traffic that must not fail.
//   - Throttling an INVALID token would mean an unauthenticated stranger can
//     force a KV write per request, on the namespace the contact form shares.
//     Exhausting the daily write quota would silently disable that form's
//     throttle. Volume buys nothing against HMAC-SHA256 in any case, so the
//     counter would be paying a real cost to defend against nothing.
//
// Cloudflare's edge absorbs the volumetric case. If that ever proves wrong the
// answer is a WAF rule on this path, not a KV counter.

import { PURPOSE_UNSUB, verifyToken } from './_subscribe_token.js';
import { LIST_SLUGS, setTopics, entriesFromClaims } from './_lists.js';

// The result page, and its query-param contract. Both are src/pages/
// unsubscribe.astro's, reconciled against it rather than invented here:
//   ?status=ok       removed
//   ?status=invalid  token missing, malformed or expired
//   ?status=error    anything else, so a Resend failure or an unset secret
const PAGE = '/unsubscribe';

// Same reasoning as confirm.js: a visitor is never told which way the token
// failed, only that it did.
const OUR_FAULT = new Set(['list_failed', 'not_configured']);
function pageStatus(reason) {
  return OUR_FAULT.has(reason) ? 'error' : 'invalid';
}

async function handle(context, oneClick) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Failure. One-click gets a status code and no page; a browser gets the page.
  const failed = (reason, status) => {
    if (oneClick) {
      return new Response(`${reason}\n`, {
        status,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return Response.redirect(new URL(`${PAGE}?status=${pageStatus(reason)}`, url).href, 303);
  };

  if (!env.RESEND_CONTACTS_API_KEY || !env.SUBSCRIBE_HMAC_KEY) {
    return failed('not_configured', 503);
  }

  const token = url.searchParams.get('token') || '';
  const result = await verifyToken(env.SUBSCRIBE_HMAC_KEY, token, {
    purpose: PURPOSE_UNSUB,
    allowed: LIST_SLUGS,
  });
  if (!result.ok) {
    return failed(result.reason, result.reason === 'expired' ? 410 : 400);
  }
  const { claims } = result;

  // Built entirely from the signed claims. verifyToken has already guaranteed
  // optIn is empty and optOut is exactly one known slug, so this can only ever
  // be a single opt_out on a single list.
  if (!(await setTopics(env, claims.email, entriesFromClaims(claims)))) {
    return failed('list_failed', 502);
  }

  if (oneClick) return new Response(null, { status: 200 });
  // Which list, like which address, stays off the URL. See confirm.js.
  return Response.redirect(new URL(`${PAGE}?status=ok`, url).href, 303);
}

export function onRequestGet(context) {
  return handle(context, false);
}

// The RFC 8058 body is `List-Unsubscribe=One-Click`. It is deliberately NOT
// required here: providers vary, and refusing a slightly off-spec one-click
// request would leave a person unable to unsubscribe. The token in the URL is
// the authentication either way, and the body carries nothing this endpoint
// needs.
export function onRequestPost(context) {
  return handle(context, true);
}
