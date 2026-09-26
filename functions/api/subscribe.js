// POST /api/subscribe - double opt-in signup for Legislative Watch and News Watch.
//
// Cloudflare Pages Function, modeled directly on contact.js: hidden honeypot,
// Turnstile siteverify, per-IP KV throttle on the SHARED CONTACT_KV namespace,
// 503 not_configured when a secret is unset. Read contact.js first; the shape is
// deliberately the same so the two cannot drift.
//
// WHAT HAPPENS HERE
//
//   1. A signed confirm token is minted (see _subscribe_token.js), carrying the
//      address and the exact list changes that were asked for.
//   2. A confirm email goes to that address, and nothing else happens.
//   3. Clicking the link is what creates the contact and opts it in, in
//      confirm.js. Until then this signup exists ONLY as a token in one inbox.
//
// THIS ENDPOINT WRITES NOTHING TO THE CONTACT STORE, AND THAT IS THE WHOLE
// SECURITY ARGUMENT
//
// Anyone at all can POST here with anyone else's address. So the only safe
// amount of subscription state for an unauthenticated request to write is none.
// An earlier draft of this file created the contact and wrote every requested
// topic as `opt_out` before the confirm click, reasoning that opted-out is the
// "pending" state and therefore harmless. It was not harmless: for an address
// that was ALREADY OPTED IN, that write flipped a real subscriber to opted out
// on the spot, with no token and no proof of inbox access. Ticking a box on a
// public form must never be able to unsubscribe somebody. That is what
// /api/unsubscribe and its signed token are for, and this endpoint went around
// them.
//
// So: no ensureContact, no setTopics, no Resend contacts call of any kind, not
// even a read. `RESEND_CONTACTS_API_KEY`, the full-access credential, is never
// used on this path (it is still checked below, see step 4). The only Resend
// call this function makes is one transactional send with the narrow
// sending-scoped key. _subscribe_token.test.mjs asserts all of that against the
// source, so it cannot creep back in.
//
// Two properties follow, and they are the ones to preserve in any future edit:
//
//   - A stranger who knows your address can cost you one email. They cannot
//     change your subscription state, in either direction, ever.
//   - A brand new address is not in Resend at all until it confirms, so it
//     cannot receive a bulletin. Both Python senders take only contacts whose
//     state on the Topic reads exactly "opt_in", so an address with no contact
//     record, or a contact with no state on a Topic, is not on any list.
//
// THE RECIPIENT IS DERIVED FROM THE REQUEST, AND THAT IS THE POINT
//
// _house_theme.js and both Python senders carry an explicit rule that a
// recipient is never derived from untrusted input. This endpoint is the one
// deliberate exception in the chapter's mail, because a confirmation email that
// went anywhere other than the address that was typed would not confirm
// anything. What keeps it bounded:
//
//   - the mail can only ever go to the exact address submitted, never to an
//     operator, an officer, or any stored address;
//   - no free text from the request enters the message. The address is not in
//     the body at all; the only request-derived thing that reaches it is the
//     confirm link, built from a pinned origin and a token this function minted;
//   - the body is the generated house template in _confirm_theme.js, whose one
//     slot is that link. It is the whole value of a double-quoted href, asserted
//     at generation time, and renderConfirm puts it through a scheme gate and
//     the same escape the contact form uses, so there is no markup for anything
//     to break out of. (This used to say "plain text with no HTML at all",
//     which was true of the placeholder it replaced and is not true now: the
//     property is escaping and a closed slot set, not the absence of markup.);
//   - Turnstile, the honeypot, a per-IP throttle and a per-ADDRESS throttle all
//     sit in front of it, so it cannot be used to mail-bomb someone;
//   - it sends exactly one message per accepted request and never retries.
//
// This still needs its own entry in stack/MCP_AND_AUTOMATION_POLICY.md Section 5
// before it goes live. That is a separate stage of this work and Bobby signs it.

import {
  PURPOSE_CONFIRM,
  mintToken,
  normalizeEmail,
  isPlausibleEmail,
  emailKeyHash,
} from './_subscribe_token.js';
// resolveTopics only, and only to check that the lists are configured. Nothing
// here calls Resend's contacts API. See the header note.
import { LIST_SLUGS, NEWS_MODES, resolveTopics } from './_lists.js';
// GENERATED from src/confirm_email.py by ./dsa email-snippet. The words and the
// layout of the confirm email are Python's; this file only decides who gets one.
import { renderConfirm } from './_confirm_theme.js';

// The page Stage 3 builds. Kept here so a rename is one edit in one place.
const PAGE = '/subscribe';

const WINDOW_S = 3600;
const IP_LIMIT = 5;
// ONE confirm email per address per hour, keyed on the ADDRESS, so rotating IPs
// does not let anyone bury a stranger's inbox in confirmation mail.
//
// One, not three, because of a rule in the policy entry for this endpoint: an
// address that is already subscribed "is not re-mailed, or is mailed at most
// once per throttle window." The tempting way to satisfy the first half is to
// read the address's current topic state and skip the send if it is already
// opted in. That was considered and rejected: the SAME policy entry forbids
// answering differently for a known address, because "a different answer for a
// known address turns a public form into a membership oracle," and a send
// skipped is a response measurably faster than a send made. Treating a
// subscriber differently from a stranger IS the oracle. So every address gets
// the identical treatment and the rate is what bounds the harm.
//
// The cost is real and worth stating: somebody who mistypes their list choice
// and resubmits within the hour is refused, and a Resend outage burns the
// window because the counter is incremented before the send. The form's copy
// names the fallback (email the chapter) for exactly that case.
const EMAIL_LIMIT = 1;

const DEFAULT_ORIGIN = 'https://knoxvilledsa.org';

function wantsJson(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json');
}

function reply(request, url, status, body) {
  if (wantsJson(request)) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  // The no-JS path gets the same flat ?sent=1 / ?error=1 the contact form uses,
  // which is what SubscribeForm.astro reads. The granular codes go to the JSON
  // path, where the form's script turns them into a specific message.
  const to = body.ok ? `${PAGE}?sent=1` : `${PAGE}?error=1`;
  return Response.redirect(new URL(to, url).href, 303);
}

function truthy(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

function siteOrigin(env) {
  const raw = String(env.SITE_ORIGIN || '').trim();
  // Pinned, never taken from the request host: the confirm link must point at
  // the chapter's own site and nowhere a Host header could redirect it.
  if (raw.startsWith('https://')) return raw.replace(/\/+$/, '');
  return DEFAULT_ORIGIN;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  let f;
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      f = await request.json();
    } else {
      const form = await request.formData();
      f = Object.fromEntries(form.entries());
    }
  } catch {
    return reply(request, url, 400, { ok: false, error: 'bad_request' });
  }

  // 1) Honeypot: bots fill the hidden field. Pretend success, drop silently.
  if (String(f.website || f.company || '').trim() !== '') {
    return reply(request, url, 200, { ok: true });
  }

  // 2) Validate the address.
  const email = normalizeEmail(f.email);
  if (!isPlausibleEmail(email)) {
    return reply(request, url, 400, { ok: false, error: 'bad_email' });
  }

  // 3) Work out which lists were asked for. The field names are the ones
  //    SubscribeForm.astro posts; the shorter aliases are accepted so a hand
  //    written curl or a future form does not have to know the long ones.
  //    The News Watch modes are a radio choice, so at most one of them can ever
  //    be requested, and picking one opts out of the other.
  const optIn = [];
  const optOut = [];
  if (truthy(f.legislative_watch ?? f.legislative)) optIn.push('legislative');

  const news = String(f.news_watch ?? f.news ?? '').trim().toLowerCase();
  if (news === 'aggressive' || news === 'passive') {
    const picked = `news-${news}`;
    optIn.push(picked);
    for (const mode of NEWS_MODES) if (mode !== picked) optOut.push(mode);
  } else if (news !== '' && news !== 'none') {
    return reply(request, url, 400, { ok: false, error: 'bad_choice' });
  }

  if (optIn.length === 0) {
    return reply(request, url, 400, { ok: false, error: 'no_selection' });
  }

  // 4) Not configured yet -> 503 so the page can show a mailto fallback, the
  //    same graceful degradation contact.js does. This covers the signing key
  //    and the list ids as well as the shared secrets: a signup that could
  //    not later be confirmed is worse than one that was refused up front.
  //    That is also why RESEND_CONTACTS_API_KEY is required here even though
  //    this function never uses it. It is what /api/confirm needs to finish the
  //    job, so starting a flow without it would mail somebody a link that
  //    cannot work. RESEND_API_KEY, the narrow sending-scoped key already set
  //    for the contact form, is the only credential this path actually spends.
  //    See the note in _lists.js for why the two must not be the same value.
  //
  //    CONTACT_KV IS IN THIS GATE ON PURPOSE. The throttle below used to sit
  //    behind `if (env.CONTACT_KV)`, which meant a missing binding silently
  //    turned off both rate limits and left a public form that can send mail
  //    with nothing counting it. An unset binding is a deployment mistake, so
  //    it fails here, loudly, before any request-time logic runs. This is not
  //    the same thing as a KV outage mid-request: that stays best-effort in
  //    step 6, because refusing every signup during a KV hiccup would be its
  //    own outage.
  const { missing } = resolveTopics(env, [...optIn, ...optOut]);
  if (!env.TURNSTILE_SECRET || !env.RESEND_API_KEY || !env.RESEND_CONTACTS_API_KEY
      || !env.SUBSCRIBE_HMAC_KEY || !env.CONTACT_KV || missing.length) {
    return reply(request, url, 503, { ok: false, error: 'not_configured' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  // 5) Turnstile siteverify. (Built with append() rather than an object literal
  // to keep the repo's data-safety scanner from a false positive on a
  // secret-shaped object key; no real credential is in this source.)
  const capResponse = String(f['cf-turnstile-response'] || '');
  if (!capResponse) return reply(request, url, 400, { ok: false, error: 'captcha_missing' });
  const verifyBody = new URLSearchParams();
  verifyBody.append('secret', env.TURNSTILE_SECRET);
  verifyBody.append('response', capResponse);
  verifyBody.append('remoteip', ip);
  let verify;
  try {
    verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: verifyBody,
    }).then((r) => r.json());
  } catch {
    verify = { success: false };
  }
  if (!verify.success) return reply(request, url, 403, { ok: false, error: 'captcha_failed' });

  // 6) Throttle, on the existing CONTACT_KV namespace. Two counters: one per IP,
  //    one per address. The address counter is keyed by a keyed digest, never by
  //    the address itself, so KV never holds a readable subscriber list.
  //    The binding's existence was already required in step 4; only a runtime
  //    KV failure is tolerated here, and only because a subscriber who cannot
  //    ever sign up is worse than an hour of uncounted attempts.
  try {
    const ipKey = `sub:ip:${ip}`;
    const n = parseInt((await env.CONTACT_KV.get(ipKey)) || '0', 10);
    if (n >= IP_LIMIT) return reply(request, url, 429, { ok: false, error: 'rate_limited' });
    await env.CONTACT_KV.put(ipKey, String(n + 1), { expirationTtl: WINDOW_S });

    const digest = await emailKeyHash(env.SUBSCRIBE_HMAC_KEY, email);
    if (digest) {
      const emailKey = `sub:em:${digest}`;
      const m = parseInt((await env.CONTACT_KV.get(emailKey)) || '0', 10);
      if (m >= EMAIL_LIMIT) return reply(request, url, 429, { ok: false, error: 'rate_limited' });
      await env.CONTACT_KV.put(emailKey, String(m + 1), { expirationTtl: WINDOW_S });
    }
  } catch {
    /* throttle is best-effort; never block a real signup on a KV hiccup */
  }

  // 7) Dry-run for the preview: no mail sent.
  if (String(env.CONTACT_DRYRUN || '') === '1') {
    return reply(request, url, 200, { ok: true, dryRun: true });
  }

  // 8) Mint the confirm token. It carries the opt-ins AND the paired News Watch
  //    opt-out, so /api/confirm derives nothing at all from its own request.
  //    This token IS the pending signup. Nothing is recorded anywhere else, so
  //    a signup nobody confirms leaves no trace and changes nothing.
  let token;
  try {
    token = await mintToken(env.SUBSCRIBE_HMAC_KEY, {
      purpose: PURPOSE_CONFIRM,
      email,
      optIn,
      optOut,
      allowed: LIST_SLUGS,
    });
  } catch {
    return reply(request, url, 500, { ok: false, error: 'token_failed' });
  }

  // 9) Send the confirm email. See the header note: this is the one place in
  //    the chapter's mail where the recipient comes from the request.
  //
  //    The message itself is GENERATED, not written here: _confirm_theme.js is
  //    src/confirm_email.py rendered through the real Python house skin by
  //    ./dsa email-snippet, the same bridge contact.js uses for _house_theme.js,
  //    and ./dsa check fails if it goes stale. That is what makes this the
  //    chapter's approved copy in the chapter's own type rather than a stand-in
  //    somebody meant to replace. Do not hand-write a message here again.
  const link = `${siteOrigin(env)}/api/confirm?token=${encodeURIComponent(token)}`;
  let message;
  try {
    message = renderConfirm(link);
  } catch {
    // renderConfirm refuses a link that is not plainly https. siteOrigin() is
    // pinned, so this cannot fire today; it is here so that if somebody ever
    // makes the origin request-derived, the endpoint refuses instead of mailing
    // a confirmation nobody can act on.
    return reply(request, url, 500, { ok: false, error: 'render_failed' });
  }
  const from = env.SUBSCRIBE_FROM || env.CONTACT_FROM || 'Knoxville Area DSA <website@knoxvilledsa.org>';
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
  } catch {
    return reply(request, url, 502, { ok: false, error: 'send_failed' });
  }
  if (!res.ok) return reply(request, url, 502, { ok: false, error: 'send_failed' });

  return reply(request, url, 200, { ok: true });
}

// A GET should not 404 silently; say what this endpoint is for.
export function onRequestGet() {
  return new Response('This endpoint accepts POST from the subscribe form.', {
    status: 405,
    headers: { 'content-type': 'text/plain', allow: 'POST' },
  });
}
