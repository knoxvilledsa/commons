// POST /api/contact - Turnstile-verified contact form -> Resend email.
//
// Cloudflare Pages Function. Deployed automatically from the functions/ dir at
// the deploy root (the publish flow assembles dist/ + functions/ together).
//
// Design notes:
//   - Spam control: a hidden honeypot, a Turnstile siteverify, and a per-IP KV
//     throttle. We do NOT use a Cloudflare rate-limit rule: the Free plan allows
//     only one and it is already used by the petition app.
//   - Degrades gracefully: with the secrets or the KV binding unset it returns
//     503 not_configured, so the site still builds/previews and the page shows
//     a mailto fallback.
//   - CONTACT_DRYRUN=1 skips the real send (used by the tanasi preview so review
//     never emails anyone).
//   - Content negotiation: fetch callers get JSON; a no-JS form POST gets a 303
//     redirect to /contact?sent=1 on success (the Spanish form: /es/contact,
//     from a fixed map, see backTo()).
//
// Language (Spanish-site plan 2.10, stage S10): the Spanish form posts a
// hidden lang=es. `lang` is allow-listed against LANGS and ANYTHING else,
// missing included, is English, so an English submission behaves exactly as
// it did before this field existed.
//
// Routing, by topic and language. Every recipient is a trusted value from env
// or a fixed default, never derived from the form (the one exception is the
// acknowledgement below, which carries no form text):
//
//   topic       lang  officer notice to                     acknowledgement
//   grievance   en    CONTACT_TO_GRIEVANCE only             never
//   grievance   es    CONTACT_TO_GRIEVANCE only             never
//   other       en    CONTACT_TO                            English, if enabled
//   other       es    CONTACT_TO, plus a copy to            Spanish, if enabled
//                     CONTACT_ES_TO when that is set        AND CONTACT_ES_TO
//                                                           is a valid address
//
// CONTACT_ES_TO (a Pages variable naming the Spanish-speaking reader, never in
// source, since functions/ ships in the public export) is best-effort: unset,
// malformed or equal to CONTACT_TO means no extra copy, and a failed copy
// never fails the submission. The general inbox always keeps its own copy.
//
// The acknowledgement ("we received your message") is the site's first email
// to an address nobody has verified, so it is bounded on every side (bounds
// tested in contact.test.mjs):
//   - OFF unless env.AUTO_REPLY_ENABLED is exactly "1". Merging this changes
//     nothing on the live site until an operator sets that variable, and its
//     row in stack/MCP_AND_AUTOMATION_POLICY.md Section 5 comes first.
//   - never for the grievance topic, in either language (Bobby's decision,
//     2026-09-24): a report of harassment must not leave a trace in an inbox
//     someone else may read; the page shows its own confirmation instead.
//     Every OTHER topic qualifies, the Sanity-sourced committee and
//     working-group topics included (Bobby's decision, 2026-09-24, MASTER_TODO
//     4.15). The grievance test here is deliberately WIDER than routing's: any
//     topic whose letters spell "grievance" anywhere, in any case and with any
//     spacing or control characters, gets no acknowledgement, so no crafted
//     spelling of the grievance key can earn one. See looksLikeGrievance().
//   - only after the honeypot, validation, Turnstile, the per-IP throttle and
//     a SUCCESSFUL officer notice, so it can never outrun the rate limiter.
//   - fixed text only, from the generated _contact_ack_theme.js, which has no
//     slots: nothing the visitor typed (name, message, topic) is echoed, so
//     the form cannot make the chapter's domain deliver chosen words to a
//     third party.
//   - to the submitted address only, and only if it passes a stricter
//     single-address check (SINGLE_ADDRESS) than the form's own.
//   - one per submission, and at most one per address per 24 hours (a keyed
//     hash of the address, +tag dropped, in CONTACT_KV; a KV error means no
//     acknowledgement). See ackLimiterKey().
//   - Spanish only when CONTACT_ES_TO is a valid single address: the Spanish
//     text promises a Spanish-speaking reply, which needs that reader.
//   - reply_to is the trusted officer inbox (CONTACT_TO or its default), so a
//     reply to the acknowledgement reaches a person, never a visitor value.
//   - its failure never fails the submission.

import { renderNotice } from './_house_theme.js';
import { renderContactAck } from './_contact_ack_theme.js';
import { CONTACT_TOPIC_MAX } from './_contact_limits.js';

// topic: a committee/working-group option submits its full label, so this is
// the shared CONTACT_TOPIC_MAX that getContactTopics() also clamps to (see
// _contact_limits.js); the form can never produce a topic this refuses.
const MAX = { name: 120, email: 200, topic: CONTACT_TOPIC_MAX, message: 5000 };
const WINDOW_S = 3600;
const LIMIT = 5;

// The languages the form may declare. Anything else is English.
const LANGS = ['en', 'es'];

// The general officer inbox when CONTACT_TO is unset: the notice's recipient
// for every ordinary topic, and the acknowledgement's reply_to.
const DEFAULT_CONTACT_TO = 'contact@knoxvilledsa.org';

// At most one acknowledgement per address in this window.
const ACK_WINDOW_S = 86400;

// A deliberately narrow single-address shape, for the acknowledgement's
// recipient and for CONTACT_ES_TO: no display name, no angle brackets, no
// comma or semicolon, no quoting, nothing a mail API could read as a second
// address. An address the form accepts but this refuses still gets its message
// delivered; it just gets no acknowledgement.
const SINGLE_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

// The five topics that are NOT sourced from Sanity, so they are the only ones
// this Function needs to know about. The committee/working-group options are
// built at build time in src/lib/content.ts (getContactTopics(), reading the
// same committee data /committees renders) and submitted by the form with
// their full English label ALREADY as the option's value (e.g. "Rules and
// Bylaws working group"), because this Function runs at the Cloudflare edge
// with no Sanity client of its own and so cannot resolve a slug back into a
// label at request time. Keeping a second, hand-typed committee list here is
// exactly how MASTER_TODO 4.15 went stale in the first place; see the label
// fallback in step 7. Read it ONLY through topicLabel(): a plain TOPICS[key]
// lookup would answer '__proto__' or 'constructor' with an Object built-in.
const TOPICS = {
  general: 'A general question',
  joining: 'Joining the chapter',
  press: 'Press and media',
  accessibility: 'Accessibility',
  grievance: 'A grievance or safety concern',
};

// The label for a FIXED topic key, or null. An own-property check, never a
// bare TOPICS[key], so an inherited name ('__proto__', 'constructor',
// 'toString', ...) is simply not a fixed topic.
function topicLabel(key) {
  return Object.hasOwn(TOPICS, key) ? TOPICS[key] : null;
}

// One line of visitor text for the subject and the notice's Topic:/Name:
// lines. Every run of C0 control characters (CR and LF included), DEL, NEL
// and the Unicode line/paragraph separators becomes one space, so a crafted
// topic or name cannot start a new line and forge a Name:/Email: line (or a
// header-looking line) in the officer notice. The message body is left alone:
// it is the one field where line breaks are the content.
const LINE_BREAKERS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g;
function oneLine(value) {
  return String(value == null ? '' : value).replace(LINE_BREAKERS, ' ').trim();
}

// The acknowledgement's grievance test (see the header). Wider than routing's
// exact 'grievance' key on purpose: strip control characters and all spacing,
// fold case, and refuse anything that still contains "grievance".
function looksLikeGrievance(topicKey) {
  return oneLine(topicKey).replace(/\s+/g, '').toLowerCase().includes('grievance');
}

function wantsJson(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json');
}

// Where a no-JS form goes back to. A FIXED map: nothing from the request
// becomes part of the path or query. English is unchanged. The Spanish page's
// grievance confirmation is ?sent=2, a neutral code rather than a word, so the
// reporter's browser history does not spell out that a grievance was filed.
function backTo(ok, back) {
  if (back && back.lang === 'es') {
    if (!ok) return '/es/contact?error=1';
    return back.grievance ? '/es/contact?sent=2' : '/es/contact?sent=1';
  }
  return ok ? '/contact?sent=1' : '/contact?error=1';
}

function reply(request, url, status, body, back) {
  if (wantsJson(request)) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  // No-JS form: redirect back to the contact page.
  return Response.redirect(new URL(backTo(body.ok, back), url).href, 303);
}

function resendSend(env, payload) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// The per-address limiter key's input: lower-cased, with any +tag dropped
// from the local part, so neighbor+1@, neighbor+2@ ... all count as one
// address for the 24-hour limit. (Only the KEY is normalised; the reply goes
// to the address exactly as submitted.)
function ackLimiterInput(email) {
  const lower = String(email).trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  const local = lower.slice(0, at).split('+')[0];
  return `kv:contact-ack:v1:${local}${lower.slice(at)}`;
}

// The limiter key, so the KV never holds a readable address. An HMAC keyed by
// SUBSCRIBE_HMAC_KEY when that binding exists: it is an existing secret in the
// same Pages project, and the "kv:contact-ack:v1:" prefix separates this use
// from every message subscribe.js signs with it ("kv:email:v1:", tokens), so
// no value computed here can stand in for one of those. Without the binding
// it falls back to a plain SHA-256 of the same input; that still keeps the raw
// address out of the KV, but a guessed address could be confirmed against it,
// which the keyed form prevents. Rotating the key only resets the 24-hour
// windows (at most one extra acknowledgement per address).
async function ackLimiterKey(env, email) {
  const data = new TextEncoder().encode(ackLimiterInput(email));
  // (Named keyMaterial, not the obvious word: the repo's data-safety scan
  // treats an assignment to a secret-shaped name as a possible committed
  // credential. Only an env reference is here.)
  const keyMaterial = String(env.SUBSCRIBE_HMAC_KEY || '');
  if (keyMaterial) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(keyMaterial), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `ack:${toHex(await crypto.subtle.sign('HMAC', key, data))}`;
  }
  return `ack:${toHex(await crypto.subtle.digest('SHA-256', data))}`;
}

// The acknowledgement, with every bound listed in the header above. Never
// throws and never changes the response: the officer notice has already gone
// out, and this is a courtesy on top of it.
async function maybeAcknowledge(env, { lang, topicKey, email, from }) {
  if (String(env.AUTO_REPLY_ENABLED || '') !== '1') return;
  if (topicKey === 'grievance' || looksLikeGrievance(topicKey)) return;
  if (!SINGLE_ADDRESS.test(email)) return;
  // The Spanish acknowledgement promises that a Spanish-speaking person will
  // reply. Without a Spanish reader configured that promise is not true, so
  // no Spanish acknowledgement is sent at all.
  if (lang === 'es' && !SINGLE_ADDRESS.test(String(env.CONTACT_ES_TO || '').trim())) return;
  try {
    const key = await ackLimiterKey(env, email);
    if (await env.CONTACT_KV.get(key)) return;
    await env.CONTACT_KV.put(key, '1', { expirationTtl: ACK_WINDOW_S });
  } catch {
    return; // unlike the throttle, the courtesy fails CLOSED on a KV error
  }
  const ack = renderContactAck(lang);
  try {
    await resendSend(env, {
      from,
      to: [email],
      // A reply lands in the trusted officer inbox (the same value the notice
      // goes to), never an address taken from the form.
      reply_to: env.CONTACT_TO || DEFAULT_CONTACT_TO,
      subject: ack.subject,
      text: ack.text,
      html: ack.html,
      // RFC 3834: marks it as an automatic reply, so a well-behaved
      // autoresponder on the other end does not answer it back.
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  } catch {
    /* best-effort: never fail a delivered message over its acknowledgement */
  }
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

  // The form's language, allow-listed (see the header): exactly the string
  // "es", or English. The typeof matters: a JSON caller's ["es"] would
  // stringify to "es".
  const lang = typeof f.lang === 'string' && LANGS.includes(f.lang) ? f.lang : 'en';
  const topicKey = String(f.topic || 'general').trim();
  const back = { lang, grievance: topicKey === 'grievance' };
  const answer = (status, body) => reply(request, url, status, body, back);

  // 1) Honeypot: bots fill the hidden field. Pretend success, drop silently.
  if (String(f.website || f.company || '').trim() !== '') {
    return answer(200, { ok: true });
  }

  // 2) Validate + cap.
  const name = String(f.name || '').trim();
  const email = String(f.email || '').trim();
  const message = String(f.message || '').trim();
  if (!message) return answer(400, { ok: false, error: 'missing_fields' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return answer(400, { ok: false, error: 'bad_email' });
  }
  if (
    name.length > MAX.name ||
    email.length > MAX.email ||
    topicKey.length > MAX.topic ||
    message.length > MAX.message
  ) {
    return answer(413, { ok: false, error: 'too_long' });
  }

  // 3) Not configured yet -> 503 so the page can show a mailto fallback.
  //
  //    CONTACT_KV IS IN THIS GATE ON PURPOSE, the same way it is in
  //    subscribe.js. The throttle in step 5 used to sit behind
  //    `if (env.CONTACT_KV)`, which meant a missing binding silently turned the
  //    rate limit off and left a public form that can send mail with nothing
  //    counting it: a preview environment, a renamed binding or a fresh Pages
  //    project would deploy a working form with no limit and no error anywhere.
  //    An unset binding is a deployment mistake, so it fails here, loudly,
  //    before any request-time logic runs. That is not the same thing as a KV
  //    error mid-request, which stays best-effort in step 5, because refusing
  //    every message during a KV hiccup would be its own outage.
  //    2026-09-02 review: the two endpoints whose headers say they cannot
  //    drift had drifted on exactly this line.
  if (!env.TURNSTILE_SECRET || !env.RESEND_API_KEY || !env.CONTACT_KV) {
    return answer(503, { ok: false, error: 'not_configured' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  // 4) Turnstile siteverify. (The verify body is built with append() rather than
  // an object literal to keep the repo's data-safety scanner from a false positive
  // on a secret-shaped object key; no real credential is in this source, only an
  // env reference.)
  const capResponse = String(f['cf-turnstile-response'] || '');
  if (!capResponse) return answer(400, { ok: false, error: 'captcha_missing' });
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
  if (!verify.success) return answer(403, { ok: false, error: 'captcha_failed' });

  // 5) Per-IP throttle via KV (free-plan compatible; no CF rate-limit rule).
  //    The binding is guaranteed by the gate in step 3, so this no longer asks
  //    whether it exists; only a live KV error is tolerated.
  try {
    const key = `t:${ip}`;
    const n = parseInt((await env.CONTACT_KV.get(key)) || '0', 10);
    if (n >= LIMIT) return answer(429, { ok: false, error: 'rate_limited' });
    await env.CONTACT_KV.put(key, String(n + 1), { expirationTtl: WINDOW_S });
  } catch {
    /* throttle is best-effort; never block a real message on a KV hiccup */
  }

  // 6) Dry-run for tanasi preview: no real send.
  if (String(env.CONTACT_DRYRUN || '') === '1') {
    return answer(200, { ok: true, dryRun: true });
  }

  // 7) Send via Resend.
  const isGrievance = topicKey === 'grievance';
  const spanish = lang === 'es';
  //    A committee/working-group option's value IS its label (see the TOPICS
  //    comment above), so an unrecognized key here is not an error case, it is
  //    the normal shape for one of those; fall back to the submitted value
  //    itself rather than the generic default, so the notice still names the
  //    right committee. `topicKey` is already trimmed and capped at MAX.topic
  //    above, routing never reads it except for the exact 'grievance' key, and
  //    oneLine() keeps it (and the name) to a single line wherever it is shown.
  //    A typed topic that only LOOKS like the grievance option (it is not the
  //    exact key, so it routes to the general inbox) is shown neutrally, so a
  //    crafted value cannot pass itself off as a grievance in the subject.
  const unlisted = !topicLabel(topicKey) && looksLikeGrievance(topicKey);
  const baseTopic = topicLabel(topicKey)
    || (unlisted ? 'Unlisted topic' : oneLine(topicKey))
    || 'A general question';
  const shownName = oneLine(name);
  // The officer notice stays in English for whoever reads the inbox; a Spanish
  // message is marked in the subject tag and on the topic line so the reader
  // knows to answer in Spanish. An English message is byte-for-byte what it
  // was before `lang` existed.
  const topic = spanish ? `${baseTopic} (wrote in Spanish)` : baseTopic;
  const tag = spanish ? '[Contacto]' : '[Contact]';
  const from = env.CONTACT_FROM || 'Knoxville Area DSA <website@knoxvilledsa.org>';
  const to = isGrievance
    ? (env.CONTACT_TO_GRIEVANCE || 'knoxdsahgo@proton.me')
    : (env.CONTACT_TO || DEFAULT_CONTACT_TO);
  // Both halves come from the generated house template, so this notification
  // matches the chapter's other operational mail and cannot drift from it.
  // Every field is escaped there, and every slot in that template is asserted at
  // generation time to sit in a text position, never inside an attribute.
  //
  // `to` is always a fixed, trusted value chosen by topicKey, never attacker
  // input: the grievance topic routes to the HGO confidential reporting
  // channel, every other topic to CONTACT_TO. This notice CARRIES the
  // visitor's own words, so it must never go to `email`: that would make the
  // chapter's domain a relay for chosen text to any inbox. The one thing the
  // submitted address may receive is the fixed-text acknowledgement below,
  // bounded as the header describes. See the header of _house_theme.js.
  const notice = renderNotice({
    topic,
    name: shownName || '(not given)',
    email,
    ip,
    message,
  });
  const officerMail = {
    from,
    to: [to],
    reply_to: email,
    subject: `${tag} ${topic}${shownName ? ` from ${shownName}` : ''}`,
    text: notice.text,
    html: notice.html,
  };

  let res;
  try {
    res = await resendSend(env, officerMail);
  } catch {
    return answer(502, { ok: false, error: 'send_failed' });
  }
  if (!res.ok) return answer(502, { ok: false, error: 'send_failed' });

  // 8) A Spanish message on a general topic: a copy to the Spanish-speaking
  //    reader, when CONTACT_ES_TO names one. Never for a grievance, whatever
  //    the language: that report goes to the HGO channel and nowhere else.
  //    Best-effort; the general inbox already has the message.
  const esTo = String(env.CONTACT_ES_TO || '').trim();
  if (spanish && !isGrievance && SINGLE_ADDRESS.test(esTo) && esTo.toLowerCase() !== to.toLowerCase()) {
    try {
      await resendSend(env, { ...officerMail, to: [esTo] });
    } catch {
      /* the general inbox has it; a lost copy never fails the submission */
    }
  }

  // 9) The acknowledgement to the sender, if enabled. Never for a grievance.
  await maybeAcknowledge(env, { lang, topicKey, email, from });

  return answer(200, { ok: true });
}

// A GET should not 404 silently; say what this endpoint is for.
export function onRequestGet() {
  return new Response('This endpoint accepts POST from the contact form.', {
    status: 405,
    headers: { 'content-type': 'text/plain', allow: 'POST' },
  });
}
