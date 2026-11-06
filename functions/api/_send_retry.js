// _send_retry.js - the durable-send helpers for the contact and subscribe
// Functions, shared with the consumer Worker in stack/commons/form-send-retry
// (which bundles this same file), so the Functions and the consumer can never
// disagree about what is worth retrying.
//
// Design: DURABLE_SEND_DESIGN.md in the workers-paid backlog package.
//
// INERT UNTIL A HUMAN BINDS A QUEUE. retryQueue() answers null unless the
// Pages project has a Queue producer binding named FORM_SEND_QUEUE, and with
// null the two Functions run their pre-existing send code unchanged: same
// request, same headers, same answers. Merging this changes nothing live.
//
// With the binding: the Function still sends inline first, now with an
// Idempotency-Key header (a fresh random UUID per message). Only a TRANSIENT
// failure (no answer, 429, 5xx, or Resend's own "same key still in flight"
// 409) puts the exact payload on the queue, and the visitor is told "sent"
// only once queue.send() has resolved, which Cloudflare documents as the
// message being written to disk. A permanent failure (any other 4xx) is
// today's 502. The consumer retries with the SAME key, so Resend (which keeps
// a key for 24 hours) never delivers the same message twice.
//
// This file ships in the public export with the rest of functions/: it holds
// no credential, only env references, and makes no network call except the
// one resendPost() is handed.

export const QUEUE_BINDING = 'FORM_SEND_QUEUE';
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

// What a queued message may be, and the only Resend fields it may carry. The
// consumer refuses (dead-letters, never sends) anything else: no cc, no bcc,
// no attachments, no headers, no scheduling.
export const KINDS = Object.freeze(['contact_notice', 'contact_es_copy', 'subscribe_confirm']);
export const MAIL_FIELDS = Object.freeze(['from', 'to', 'reply_to', 'subject', 'text', 'html']);
export const MESSAGE_VERSION = 1;

// The schedule. The first queued delivery waits FIRST_DELAY_S; after a
// transient failure on queued delivery n (1-based, Cloudflare's msg.attempts)
// the next waits RETRY_DELAYS_S[n-1]. After MAX_DELIVERIES the message is
// dead-lettered. Total: 30 s + about 3 h 3 min, far inside Resend's 24-hour
// idempotency window and inside the main queue's 6-hour retention.
export const FIRST_DELAY_S = 30;
export const RETRY_DELAYS_S = Object.freeze([60, 120, 240, 480, 960, 1920, 3600, 3600]);
export const MAX_DELIVERIES = RETRY_DELAYS_S.length + 1;

// A message older than this is dead-lettered unsent: past Resend's 24-hour
// key window a resend could duplicate. Only reachable if delivery was paused.
export const MAX_AGE_MS = 20 * 3600 * 1000;

// Cloudflare's per-message limit is 128 KB including metadata.
export const MAX_MESSAGE_BYTES = 120000;

export const SEND_TIMEOUT_MS = 15000;

// Sequential sends in the consumer, spaced so a released backlog does not
// trip Resend's per-second rate limit.
export const SEND_GAP_MS = 600;

// One recipient, no display name, nothing a mail API could read as a second
// address: the port of the Python senders' _ADDR_RE that subscribe.js uses,
// so every address the subscribe form accepts passes here too.
const ONE_ADDRESS = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[A-Za-z]{2,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// The only sending domain a queued message may use. The Function's From is
// env.CONTACT_FROM / SUBSCRIBE_FROM or the default, all at this domain; a
// queued message claiming any other sender is refused, never sent.
export const SENDING_DOMAIN = 'knoxvilledsa.org';
// `Display Name <addr>` or a bare address; the display name may not carry
// angle brackets, a double quote or a control character.
const FROM_SHAPE = /^(?:[^<>"\u0000-\u001f\u007f]*<([^<>\s]+)>|([^<>\s]+))$/;

// True when `from` names exactly one address, at SENDING_DOMAIN.
export function fromIsChapter(from) {
  if (typeof from !== 'string') return false;
  const m = from.trim().match(FROM_SHAPE);
  if (!m) return false;
  const addr = m[1] || m[2];
  return ONE_ADDRESS.test(addr) && addr.toLowerCase().endsWith(`@${SENDING_DOMAIN}`);
}
const KEY_SHAPE = /^[A-Za-z0-9-]{16,100}$/;

// The Queue producer binding, or null. Anything that is not an object with a
// send() function (unset, a string variable, a mistyped binding) is null, so
// the caller runs today's code.
export function retryQueue(env) {
  const q = env ? env[QUEUE_BINDING] : null;
  return q && typeof q === 'object' && typeof q.send === 'function' ? q : null;
}

export function newSendKey() {
  return crypto.randomUUID();
}

// sent | transient | permanent. `status` 0 means no HTTP answer at all.
// `name` is the Resend error name, read only from a 409 body.
export function classifySend(status, name = '') {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 0) return 'transient';
  if (status === 429) return 'transient';
  if (status >= 500 && status < 600) return 'transient';
  if (status === 409 && name === 'concurrent_idempotent_requests') return 'transient';
  return 'permanent';
}

// The retry delay after queued delivery `attempts` failed, or null when the
// cap is reached and the message must be dead-lettered.
export function retryDelaySeconds(attempts) {
  const n = Number(attempts);
  if (!Number.isInteger(n) || n < 1 || n > RETRY_DELAYS_S.length) return null;
  return RETRY_DELAYS_S[n - 1];
}

// One POST to Resend with the idempotency key. Never throws. Returns
// { status, name }: status 0 when nothing answered, name only for a 409.
// No response body is read except a 409's error name, and nothing here logs.
export async function resendPost(fetchFn, sendingKey, mail, key) {
  let res;
  try {
    res = await fetchFn(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sendingKey}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, name: '' };
  }
  let name = '';
  try {
    if (res.status === 409) {
      const j = await res.json();
      if (j && typeof j.name === 'string') name = j.name;
    } else if (res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
  } catch {
    /* an unreadable body changes nothing: the status decides */
  }
  return { status: res.status, name };
}

export function buildMessage(kind, key, mail, now = Date.now()) {
  return { v: MESSAGE_VERSION, kind, key, at: now, mail };
}

// The shape the consumer will send, checked on BOTH sides: the Function never
// queues what the consumer would refuse, and the consumer never sends what the
// Function would not have built. { ok: true } or { ok: false, why }.
export function validateMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, why: 'not_object' };
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'at,key,kind,mail,v') return { ok: false, why: 'fields' };
  if (body.v !== MESSAGE_VERSION) return { ok: false, why: 'version' };
  if (!KINDS.includes(body.kind)) return { ok: false, why: 'kind' };
  if (typeof body.key !== 'string' || !KEY_SHAPE.test(body.key)) return { ok: false, why: 'key' };
  if (typeof body.at !== 'number' || !Number.isFinite(body.at)) return { ok: false, why: 'at' };
  const m = body.mail;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, why: 'mail' };
  for (const k of Object.keys(m)) {
    if (!MAIL_FIELDS.includes(k)) return { ok: false, why: 'mail_field' };
  }
  for (const k of ['from', 'subject', 'text', 'html']) {
    if (typeof m[k] !== 'string' || m[k] === '') return { ok: false, why: `mail_${k}` };
  }
  if (CONTROL.test(m.from) || CONTROL.test(m.subject)) return { ok: false, why: 'mail_header_chars' };
  if (!fromIsChapter(m.from)) return { ok: false, why: 'mail_from' };
  if (!Array.isArray(m.to) || m.to.length !== 1 || typeof m.to[0] !== 'string'
      || !ONE_ADDRESS.test(m.to[0])) {
    return { ok: false, why: 'mail_to' };
  }
  // reply_to is the visitor's address on a contact notice. The contact form's
  // own check is looser than this, so an address it accepted but this refuses
  // (a comma, an angle bracket) is simply not queued: on a transient failure
  // that submission gets today's 502, exactly as before the queue existed.
  if ('reply_to' in m) {
    if (typeof m.reply_to !== 'string' || m.reply_to.length > 320 || !ONE_ADDRESS.test(m.reply_to)) {
      return { ok: false, why: 'mail_reply_to' };
    }
  }
  return { ok: true };
}

export function messageBytes(body) {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

// The Function side, used only when retryQueue(env) returned a queue. Sends
// inline with a fresh key; on a transient failure queues the same payload
// with the same key. Never throws. Answers { outcome, status } where outcome
// is 'sent', 'queued' or 'failed' (the caller's today-shaped 502).
export async function deliverOrQueue({ queue, kind, mail, sendingKey, fetchFn, now }) {
  try {
    const key = newSendKey();
    const doFetch = fetchFn || ((...a) => fetch(...a));
    const r = await resendPost(doFetch, sendingKey, mail, key);
    const cls = classifySend(r.status, r.name);
    if (cls === 'sent') return { outcome: 'sent', status: r.status };
    if (cls === 'permanent') return { outcome: 'failed', status: r.status };
    const body = buildMessage(kind, key, mail, typeof now === 'number' ? now : Date.now());
    if (!validateMessage(body).ok) return { outcome: 'failed', status: r.status };
    if (messageBytes(body) > MAX_MESSAGE_BYTES) return { outcome: 'failed', status: r.status };
    await queue.send(body, { contentType: 'json', delaySeconds: FIRST_DELAY_S });
    return { outcome: 'queued', status: r.status };
  } catch {
    return { outcome: 'failed', status: 0 };
  }
}
