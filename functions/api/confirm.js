// GET /api/confirm?token=... - the double opt-in confirm click.
//
// Verifies the signed token from the confirm email and flips the topics it
// names from opted out to opted in. Nothing here is derived from the request
// except the token: the address and the exact list changes all come out of the
// signed payload, so a confirm link cannot be pointed at another address or
// another list.
//
// SINGLE USE, AND THE HONEST LIMIT OF IT
//
// Replaying a confirm token is not harmless. Someone who unsubscribes and then
// has an old confirm link replayed against them would be put back on the list
// against their wishes, which is a consent problem however small the list.
// A signature alone cannot prevent that, because a stateless token has no
// memory. So the nonce is burned in CONTACT_KV after a successful confirm,
// with a TTL that outlives the token, and a burned nonce is refused.
//
// Two limits worth stating plainly rather than pretending away:
//   - KV is eventually consistent, so two clicks within a second or so can both
//     land. Both do the same flip, so the outcome is identical.
//   - If KV is unavailable the burn is skipped rather than failing the confirm,
//     because a subscriber who cannot ever confirm is a worse outcome than a
//     replayable link during an outage. Single use is therefore best effort,
//     and the 48 hour expiry is the hard bound.
// That tolerance is for a TRANSIENT outage and nothing else. A CONTACT_KV
// binding that is not there at all is a deployment mistake, not an outage, and
// it would mean single use was never enforced on any click. So the binding is
// required in the not-configured gate below, before any of this runs, and the
// code past that point no longer asks whether KV exists.
// The burn happens AFTER the flip succeeds, so a Resend failure leaves the link
// usable and the person can click it again instead of being stranded.
//
// One more real-world wrinkle: corporate mail scanners and link checkers fetch
// every URL in a message before the human ever sees it. That fetch would confirm
// the subscription and burn the nonce, and the human's own click a minute later
// would then be told the link was already used, which reads like a broken site.
// So a burned nonce presented again WITHIN A SHORT GRACE WINDOW shows success
// without touching Resend, and only a much later replay is refused. That keeps
// the protection that matters, which is a stale link resurrecting a subscription
// somebody has since cancelled.

import { PURPOSE_CONFIRM, verifyToken } from './_subscribe_token.js';
import { LIST_SLUGS, ensureContact, setTopics, entriesFromClaims } from './_lists.js';

// The result page, and its query-param contract. Both are src/pages/
// subscribed.astro's, reconciled against it rather than invented here:
//   ?status=ok       confirmed
//   ?status=invalid  token missing, malformed, expired or reused
//   ?status=error    anything else, so a Resend failure or an unset secret
const PAGE = '/subscribed';

const NONCE_TTL_SLACK_S = 3600;
const FALLBACK_TTL_S = 48 * 3600;
// How long after a confirm the same link still reads as success rather than as
// a used link. Long enough to cover a scanner prefetch and a human click, short
// enough that it is not a replay window worth attacking.
const GRACE_S = 600;

// Every reason a token can fail collapses to "invalid" on the page. A page that
// distinguished "bad signature" from "malformed payload" would be a free oracle
// for anyone probing the signing key, and the difference means nothing to a
// person who just clicked a link. "error" is reserved for our side failing.
const OUR_FAULT = new Set(['list_failed', 'not_configured']);
function pageStatus(reason) {
  return OUR_FAULT.has(reason) ? 'error' : 'invalid';
}

function wantsJson(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json');
}

function fail(request, url, status, reason) {
  if (wantsJson(request)) {
    // The granular reason stays on the JSON path, which is where the tests and
    // any future tooling look. It is never shown to a visitor.
    return new Response(JSON.stringify({ ok: false, error: reason }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return Response.redirect(new URL(`${PAGE}?status=${pageStatus(reason)}`, url).href, 303);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.RESEND_CONTACTS_API_KEY || !env.SUBSCRIBE_HMAC_KEY || !env.CONTACT_KV) {
    return fail(request, url, 503, 'not_configured');
  }

  const token = url.searchParams.get('token') || '';
  const result = await verifyToken(env.SUBSCRIBE_HMAC_KEY, token, {
    purpose: PURPOSE_CONFIRM,
    allowed: LIST_SLUGS,
  });
  if (!result.ok) {
    return fail(request, url, result.reason === 'expired' ? 410 : 400, result.reason);
  }
  const { claims } = result;

  const now = Math.floor(Date.now() / 1000);

  // Single use. Checked before acting, burned after.
  const nonceKey = `sub:used:${claims.nonce}`;
  try {
    const burned = await env.CONTACT_KV.get(nonceKey);
    if (burned) {
      const at = parseInt(burned, 10);
      if (Number.isFinite(at) && now - at <= GRACE_S) {
        return success(request, url, claims);
      }
      return fail(request, url, 409, 'used');
    }
  } catch {
    /* best effort; see the header note */
  }

  // THIS IS WHERE THE CONTACT IS CREATED, and this function is the ONLY place
  // in the feature that ever writes an opt-in. /api/subscribe deliberately
  // writes nothing at all (see its header), so a signup that is never confirmed
  // never becomes a record, and a signup submitted by somebody else in your name
  // never touches the state you already had. Everything below is built from the
  // signed claims, so the click is what authorises it.
  //
  // ensureContact is idempotent, so the ordinary case (the address is already a
  // contact, subscribing to a second list) costs one harmless call.
  if (!(await ensureContact(env, claims.email))) {
    return fail(request, url, 502, 'list_failed');
  }
  if (!(await setTopics(env, claims.email, entriesFromClaims(claims)))) {
    return fail(request, url, 502, 'list_failed');
  }

  try {
    const remaining = claims.expires > 0 ? claims.expires - now : FALLBACK_TTL_S;
    const ttl = Math.max(60, remaining + NONCE_TTL_SLACK_S);
    await env.CONTACT_KV.put(nonceKey, String(now), { expirationTtl: ttl });
  } catch {
    /* best effort; see the header note */
  }

  return success(request, url, claims);
}

// Nothing about WHO confirmed goes on the redirect URL. A query string ends up
// in browser history, in referrers and in logs, and a subscriber's address is
// private associational data, so the page is told only that it worked.
function success(request, url, claims) {
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: true, lists: claims.optIn }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return Response.redirect(new URL(`${PAGE}?status=ok`, url).href, 303);
}

// Confirm links are clicked, so this is a GET endpoint. A POST gets 405 rather
// than an alias, which keeps the surface as small as the flow needs.
export function onRequestPost() {
  return new Response('This endpoint is the confirm link from a signup email.', {
    status: 405,
    headers: { 'content-type': 'text/plain', allow: 'GET' },
  });
}
