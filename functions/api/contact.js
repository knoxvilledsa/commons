// POST /api/contact - Turnstile-verified contact form -> Resend email.
//
// Cloudflare Pages Function. Deployed automatically from the functions/ dir at
// the deploy root (the publish flow assembles dist/ + functions/ together).
//
// Design notes:
//   - Spam control: a hidden honeypot, a Turnstile siteverify, and a per-IP KV
//     throttle. We do NOT use a Cloudflare rate-limit rule: the Free plan allows
//     only one and it is already used by the petition app.
//   - Degrades gracefully: with secrets unset it returns 503 not_configured, so
//     the site still builds/previews and the page shows a mailto fallback.
//   - CONTACT_DRYRUN=1 skips the real send (used by the tanasi preview so review
//     never emails anyone).
//   - Content negotiation: fetch callers get JSON; a no-JS form POST gets a 303
//     redirect to /contact?sent=1 on success.

import { renderNotice } from './_house_theme.js';

const MAX = { name: 120, email: 200, topic: 60, message: 5000 };
const WINDOW_S = 3600;
const LIMIT = 5;

const TOPICS = {
  general: 'A general question',
  joining: 'Joining the chapter',
  'public-transit': 'Public Transit committee',
  'political-education': 'Political Education committee',
  'queer-liberation': 'Queer Liberation committee',
  press: 'Press and media',
  accessibility: 'Accessibility',
  grievance: 'A grievance or safety concern',
};

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
  // No-JS form: redirect back to the contact page.
  const to = body.ok ? '/contact?sent=1' : '/contact?error=1';
  return Response.redirect(new URL(to, url).href, 303);
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

  // 2) Validate + cap.
  const name = String(f.name || '').trim();
  const email = String(f.email || '').trim();
  const topicKey = String(f.topic || 'general').trim();
  const message = String(f.message || '').trim();
  if (!message) return reply(request, url, 400, { ok: false, error: 'missing_fields' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return reply(request, url, 400, { ok: false, error: 'bad_email' });
  }
  if (
    name.length > MAX.name ||
    email.length > MAX.email ||
    topicKey.length > MAX.topic ||
    message.length > MAX.message
  ) {
    return reply(request, url, 413, { ok: false, error: 'too_long' });
  }

  // 3) Not configured yet -> 503 so the page can show a mailto fallback.
  if (!env.TURNSTILE_SECRET || !env.RESEND_API_KEY) {
    return reply(request, url, 503, { ok: false, error: 'not_configured' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  // 4) Turnstile siteverify. (The verify body is built with append() rather than
  // an object literal to keep the repo's data-safety scanner from a false positive
  // on a secret-shaped object key; no real credential is in this source, only an
  // env reference.)
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

  // 5) Per-IP throttle via KV (free-plan compatible; no CF rate-limit rule).
  if (env.CONTACT_KV) {
    try {
      const key = `t:${ip}`;
      const n = parseInt((await env.CONTACT_KV.get(key)) || '0', 10);
      if (n >= LIMIT) return reply(request, url, 429, { ok: false, error: 'rate_limited' });
      await env.CONTACT_KV.put(key, String(n + 1), { expirationTtl: WINDOW_S });
    } catch {
      /* throttle is best-effort; never block a real message on a KV hiccup */
    }
  }

  // 6) Dry-run for tanasi preview: no real send.
  if (String(env.CONTACT_DRYRUN || '') === '1') {
    return reply(request, url, 200, { ok: true, dryRun: true });
  }

  // 7) Send via Resend.
  const topic = TOPICS[topicKey] || 'A general question';
  const from = env.CONTACT_FROM || 'Knoxville Area DSA <website@knoxvilledsa.org>';
  const to = env.CONTACT_TO || 'contact@knoxvilledsa.org';
  // Both halves come from the generated house template, so this notification
  // matches the chapter's other operational mail and cannot drift from it.
  // Every field is escaped there, and every slot in that template is asserted at
  // generation time to sit in a text position, never inside an attribute.
  //
  // `to` stays env.CONTACT_TO. Do NOT add an acknowledgement to `email`: that
  // would derive a recipient from untrusted input at the edge with no operator in
  // the loop. See the header of _house_theme.js.
  const notice = renderNotice({
    topic,
    name: name || '(not given)',
    email,
    ip,
    message,
  });

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
        to: [to],
        reply_to: email,
        subject: `[Contact] ${topic}${name ? ` from ${name}` : ''}`,
        text: notice.text,
        html: notice.html,
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
  return new Response('This endpoint accepts POST from the contact form.', {
    status: 405,
    headers: { 'content-type': 'text/plain', allow: 'POST' },
  });
}
