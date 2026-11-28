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
// GET IS THE VISIBLE FOOTER LINK, AND IT CHANGES NOTHING. It verifies the token
// and renders a one-button page; the button POSTs back here, and only that POST
// writes. This is not "are you sure" friction, which would still be the wrong
// thing on the way out of a list. It is the same fact confirm.js already builds
// around at its lines 33-40: corporate mail scanners and link checkers fetch
// every URL in a message before the human ever sees it. A GET that acted would
// therefore opt people out the moment the bulletin was delivered, with no click
// and no record, and hardest on exactly the institutional and union addresses
// these lists are for. So the state change lives behind the POST, where a
// scanner's prefetch cannot reach it, and where the RFC 8058 one-click button
// already is. 2026-09-02 review.
//
// The confirmation page is rendered by this Function rather than by the static
// site, because the token must not land on a page URL: it is a base64url JSON
// payload carrying the subscriber's address (_subscribe_token.js), and the same
// reason keeps the address off the result-page redirect below. unsubscribe.astro
// is prerendered and could not consume a token anyway.
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
import { LISTS, LIST_SLUGS, setTopics, entriesFromClaims } from './_lists.js';
import { houseEscape } from './_house_theme.js';

// The result page, and its query-param contract. Both are src/pages/
// unsubscribe.astro's, reconciled against it rather than invented here:
//   ?status=ok       removed
//   ?status=invalid  token missing, malformed or expired
//   ?status=error    anything else, so a Resend failure or an unset secret
const PAGE = '/unsubscribe';

// This endpoint's own path, which the confirmation form posts back to.
const ENDPOINT = '/api/unsubscribe';

// The hidden field the confirmation form carries. Its only job is to tell a
// press of our own button apart from a provider's one-click POST, so the two
// can get the answer each expects.
const CONFIRM_FIELD = 'confirm';

// Same reasoning as confirm.js: a visitor is never told which way the token
// failed, only that it did.
const OUR_FAULT = new Set(['list_failed', 'not_configured']);
function pageStatus(reason) {
  return OUR_FAULT.has(reason) ? 'error' : 'invalid';
}

// Failure, told two ways. One-click gets a status code and no page; a browser
// gets the result page.
function pageFail(url, reason) {
  return Response.redirect(new URL(`${PAGE}?status=${pageStatus(reason)}`, url).href, 303);
}
function plainFail(reason, status) {
  return new Response(`${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

// Config check plus signature check, shared by both verbs. Returns the claims
// on success and a reason plus the status code the one-click path owes on
// failure. It reads nothing from the request but the token.
async function verify(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  if (!env.RESEND_CONTACTS_API_KEY || !env.SUBSCRIBE_HMAC_KEY) {
    return { ok: false, reason: 'not_configured', status: 503, url, token };
  }

  const result = await verifyToken(env.SUBSCRIBE_HMAC_KEY, token, {
    purpose: PURPOSE_UNSUB,
    allowed: LIST_SLUGS,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      status: result.reason === 'expired' ? 410 : 400,
      url,
      token,
    };
  }
  return { ok: true, claims: result.claims, url, token };
}

// Did this POST come from the button on the page above, or from a mail
// provider's one-click? The hidden field decides it, because that is the one
// signal we mint ourselves; the Accept header is only a fallback for a body we
// could not read. A provider that sent both a one-click body and an HTML Accept
// header would get the 303 instead of the empty 200, which is a cosmetic
// mismatch and not a failed unsubscribe: the opt-out has already been written
// by then, and a retry writes the same state.
async function fromOurPage(request) {
  const contentType = request.headers.get('content-type') || '';
  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      const form = await request.formData();
      if (String(form.get(CONFIRM_FIELD) || '') !== '') return true;
    } catch {
      /* an unreadable body is not our form; fall through to the header */
    }
  }
  return (request.headers.get('accept') || '').includes('text/html');
}

// The page the footer link lands on. Copy follows the porch register in
// .claude/rules/brand-voice.md: plain, second person, verb-first button, and
// it says why the extra click exists rather than pretending it is a hurdle.
//
// The token goes in the form action and nowhere else. It is already restricted
// to base64url by the time it gets here (verifyToken has accepted it), and it
// is escaped anyway, so it cannot break out of the attribute.
function confirmPage(token, label) {
  const action = `${ENDPOINT}?token=${houseEscape(token)}`;
  const listName = houseEscape(label);
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Leave ${listName} · Knoxville Area DSA</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; background:#f4f4f4; color:#231F20;
         font:400 16px/1.6 Helvetica,Arial,sans-serif; }
  .card { max-width:640px; margin:48px auto; padding:32px 28px;
          background:#ffffff; border-top:4px solid #EC1F27; }
  h1 { margin:0 0 16px; font-size:24px; line-height:1.25; font-weight:700; }
  p { margin:0 0 16px; }
  .why { color:#6b6b6b; font-size:14px; }
  button { display:inline-block; margin:8px 0 0; padding:12px 22px; border:0;
           background:#EC1F27; color:#ffffff; font:700 16px/1 Helvetica,Arial,sans-serif;
           cursor:pointer; }
  @media (prefers-color-scheme: dark) {
    body { background:#151515; color:#e8e8e8; }
    .card { background:#242424; }
    .why { color:#a8a8a8; }
  }
</style>
</head>
<body>
  <main class="card">
    <h1>Leave ${listName}</h1>
    <p>Nothing has changed yet. Press the button and we will take you off this list.</p>
    <form method="post" action="${action}">
      <input type="hidden" name="${CONFIRM_FIELD}" value="1">
      <button type="submit">Unsubscribe me</button>
    </form>
    <p class="why">We ask for the press because mail scanners open every link in a message before you see it. A link that acted on its own would drop people who never clicked.</p>
    <p class="why">Changed your mind? Close this page and nothing happens.</p>
  </main>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The URL carries a token, so it stays out of caches and out of referrers.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}

export async function onRequestGet(context) {
  const result = await verify(context);
  if (!result.ok) return pageFail(result.url, result.reason);

  // NOTHING IS WRITTEN ON A GET. See the header: a scanner prefetching this URL
  // must not be able to unsubscribe anybody. verifyToken has already guaranteed
  // optOut is exactly one known slug, so the label below is one of ours.
  const slug = result.claims.optOut[0];
  return confirmPage(result.token, (LISTS[slug] && LISTS[slug].label) || 'this list');
}

// The RFC 8058 body is `List-Unsubscribe=One-Click`. It is deliberately NOT
// required here: providers vary, and refusing a slightly off-spec one-click
// request would leave a person unable to unsubscribe. The token in the URL is
// the authentication either way, and the body carries nothing this endpoint
// needs beyond the confirm field our own form adds.
export async function onRequestPost(context) {
  const { request, env } = context;

  // Read the body first: nothing else consumes it, and the answer shape depends
  // on who is asking.
  const browser = await fromOurPage(request);

  const result = await verify(context);
  if (!result.ok) {
    return browser ? pageFail(result.url, result.reason) : plainFail(result.reason, result.status);
  }
  const { claims } = result;

  // Built entirely from the signed claims. verifyToken has already guaranteed
  // optIn is empty and optOut is exactly one known slug, so this can only ever
  // be a single opt_out on a single list.
  if (!(await setTopics(env, claims.email, entriesFromClaims(claims)))) {
    return browser ? pageFail(result.url, 'list_failed') : plainFail('list_failed', 502);
  }

  if (!browser) return new Response(null, { status: 200 });
  // Which list, like which address, stays off the URL. See confirm.js.
  return Response.redirect(new URL(`${PAGE}?status=ok`, result.url).href, 303);
}
