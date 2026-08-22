// Signed subscribe/confirm/unsubscribe tokens. HMAC-SHA256 over Workers' native
// crypto.subtle. No dependency, no KV read needed to validate: the signature IS
// the proof.
//
// THIS FILE CARRIES NO SEND CAPABILITY, NO RECIPIENT AND NO NETWORK CALL. It is
// pure crypto plus validation, so it can be audited on its own. The endpoints
// that act on a verified token live in subscribe.js / confirm.js /
// unsubscribe.js; the Resend calls live in _lists.js.
//
// The same tokens are minted by the Python senders (src/legislative_monitor/
// send_digest.py and src/dsa_news/send.py) for the List-Unsubscribe header, so
// the format below is a CONTRACT, not an implementation detail. Read
// TOKEN_FORMAT before changing anything here, and bump `v` rather than
// redefining a field.
//
// ---------------------------------------------------------------------------
// TOKEN_FORMAT (v1)
// ---------------------------------------------------------------------------
//
//   token = <payload> "." <signature>
//
//   payload   = base64url( utf8( JSON ) ), no "=" padding
//   signature = base64url( HMAC-SHA256( key, ascii(payload) ) ), no padding
//
// The signature is computed over the ASCII BYTES OF THE TRANSMITTED PAYLOAD
// SEGMENT, never over re-serialized JSON. That is the whole reason this is
// portable: neither side has to agree on key order, whitespace, or unicode
// escaping. Each side signs the exact string it emits, and the verifier signs
// the exact string it received. Verification decodes the JSON for READING only,
// and only after the signature has already checked out.
//
//   key = utf8 bytes of the SUBSCRIBE_HMAC_KEY secret, used raw. It is NOT hex
//         decoded and NOT base64 decoded. Treat the secret as an opaque string.
//
// JSON payload fields, all required:
//
//   v  number   format version, must be 1
//   p  string   purpose, "confirm" or "unsub"
//   e  string   email, already lowercased and trimmed
//   i  string[] list slugs to OPT IN
//   o  string[] list slugs to OPT OUT
//   t  number   issued at, unix seconds
//   x  number   expires at, unix seconds, or 0 for "never expires"
//   n  string   nonce, 16 random bytes base64url (22 chars)
//
// `t` is informational and is never used in a decision; `x` alone governs
// lifetime. `i` and `o` are the only fields that may be omitted, and an absent
// one reads as an empty array, so a Python sender that leaves `i` out of an
// unsub token is still valid. Every other field must be present, and must be of
// the type listed, or the token is refused.
//
// Structural rules, enforced identically at mint and at verify:
//
//   - every slug in i and o is in the caller-supplied allowlist
//   - i and o are disjoint, each has no duplicates
//   - p == "unsub"   => i is empty AND o has exactly one slug
//   - p == "confirm" => i has at least one slug
//
// The i/o split is what keeps a token from doing anything other than what it
// was minted for. Both endpoints build their Resend call ENTIRELY from the
// signed i and o arrays and derive nothing else from the request, so a token
// cannot be pointed at a list it does not name.
//
// PYTHON REFERENCE IMPLEMENTATION (stdlib only). The senders mint the
// List-Unsubscribe token with this; the vectors in _subscribe_token.test.mjs
// were produced by it and are asserted against the JavaScript above.
//
//   import base64, hmac, hashlib, json, secrets, time
//
//   def _b64u(raw: bytes) -> str:
//       return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
//
//   def mint_unsub_token(key: str, email: str, slug: str) -> str:
//       claims = {
//           "v": 1,
//           "p": "unsub",
//           "e": email.strip().lower(),
//           "i": [],
//           "o": [slug],
//           "t": int(time.time()),
//           "x": 0,                       # unsubscribe tokens do not expire
//           "n": _b64u(secrets.token_bytes(16)),
//       }
//       payload = _b64u(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
//       sig = hmac.new(key.encode("utf-8"), payload.encode("ascii"),
//                      hashlib.sha256).digest()
//       return payload + "." + _b64u(sig)
//
// json.dumps' key order and separators do NOT have to match JavaScript's,
// because each side signs the exact base64url string it emits and the verifier
// signs the exact string it received. Nothing is ever re-serialized.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const TOKEN_VERSION = 1;
export const PURPOSE_CONFIRM = 'confirm';
export const PURPOSE_UNSUB = 'unsub';

// A confirm click is a one-time action taken within a day or two of asking.
// 48 hours is generous for that and still bounds the window in which a link
// sitting in a forwarded or shared inbox can activate a subscription.
export const CONFIRM_TTL_S = 48 * 3600;

// Unsubscribe tokens do not expire (x = 0) ON PURPOSE. A List-Unsubscribe
// header has to keep working for as long as that message can be found, which
// for an archived mailing list message is years. The blast radius of a
// long-lived unsubscribe token is exactly one thing: stopping mail to the one
// address it names, on the one list it names. That is not an escalation, it is
// the same action the recipient could take by clicking. Rotating
// SUBSCRIBE_HMAC_KEY is the revocation mechanism, and it invalidates every
// outstanding token of both kinds at once.
export const UNSUB_TTL_S = 0;

const MAX_TOKEN_CHARS = 4096;
const MAX_EMAIL_CHARS = 200;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

// A PORT OF THE PYTHON SENDERS' _ADDR_RE, AND IT HAS TO STAY ONE.
//
// The Python side is the last word on who actually gets mail:
//
//   src/legislative_monitor/send_digest.py  }  _ADDR_RE = re.compile(
//   src/dsa_news/send.py                    }    r"^[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[A-Za-z]{2,}$")
//
// and an address that does not match it is SKIPPED at send time, logged only as
// an anonymous count. So an address this file accepts but Python rejects gets
// all the way through the public sign-up, the confirm click and the opt-in
// write, and then silently never receives anything, forever, with nobody able
// to say whose it was. The looser shape contact.js uses (`[^@\s]+@[^@\s]+\.[^@\s]+$`)
// did exactly that: it admits `,` `;` `<` `>` `"`, numeric TLDs and one-letter
// TLDs. Validating identically here moves that failure to the one moment the
// person can still fix their own typo.
//
// The two classes are the same language, with two deliberate exceptions, both
// in the direction of THIS side being the stricter one, which is the safe
// direction (anything accepted here is accepted there):
//
//   - U+001C to U+001F and U+0085 are whitespace to Python's `\s` but not to
//     JavaScript's, so they are spelled out in the class below to keep the
//     exclusion equal. (JavaScript's `\s` also covers U+FEFF, which Python's
//     does not; that makes this side reject one more junk character, fine.)
//   - Python's `$` also matches just before a trailing newline and JavaScript's
//     does not, so "a@b.com\n" passes there and fails here. normalizeEmail
//     trims before this ever runs, so it cannot come up in practice.
//
// MAX_EMAIL_CHARS is a cap Python does not have, again stricter, again fine.
//
// Change one side and you must change the other. There is no test that can
// diff two regexes across two languages, so this comment is the contract.
const EMAIL_RE = /^[^@\s\u001c-\u001f\u0085,;<>"]+@[^@\s\u001c-\u001f\u0085,;<>"]+\.[A-Za-z]{2,}$/;

export function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

export function isPlausibleEmail(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_EMAIL_CHARS &&
    EMAIL_RE.test(value)
  );
}

export function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
  if (typeof text !== 'string' || !B64URL_RE.test(text)) return null;
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  let bin;
  try {
    bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(secret, message) {
  const key = await importKey(secret);
  if (!key) return null;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Length-independent-branch compare. An HMAC comparison is not a realistic
// remote timing target, but there is no reason to write the sloppy version.
function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// A keyed, non-reversible handle for an email address, for use as a KV key.
// KV is a third-party store and the chapter treats subscriber addresses as
// private associational data, so no plaintext address is ever written there,
// and keying the digest means the stored values are not a rainbow-tableable
// list of addresses either.
export async function emailKeyHash(secret, email) {
  const mac = await sign(secret, `kv:email:v1:${normalizeEmail(email)}`);
  if (!mac) return null;
  let hex = '';
  for (let i = 0; i < 16; i += 1) hex += mac[i].toString(16).padStart(2, '0');
  return hex;
}

function cleanSlugs(value, allowed) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    if (!allowed.includes(raw)) return null;
    if (out.includes(raw)) return null;
    out.push(raw);
  }
  return out;
}

// Shared by mint and verify so the two can never drift.
function checkClaims(claims, allowed) {
  if (!claims || typeof claims !== 'object') return 'malformed';
  if (claims.v !== TOKEN_VERSION) return 'bad_version';
  if (claims.p !== PURPOSE_CONFIRM && claims.p !== PURPOSE_UNSUB) return 'bad_purpose';
  if (!isPlausibleEmail(claims.e)) return 'bad_email';
  if (typeof claims.t !== 'number' || !Number.isFinite(claims.t)) return 'malformed';
  if (typeof claims.x !== 'number' || !Number.isFinite(claims.x) || claims.x < 0) return 'malformed';
  if (typeof claims.n !== 'string' || !B64URL_RE.test(claims.n)) return 'malformed';

  const optIn = cleanSlugs(claims.i, allowed);
  const optOut = cleanSlugs(claims.o, allowed);
  if (optIn === null || optOut === null) return 'unknown_list';
  for (const slug of optIn) if (optOut.includes(slug)) return 'contradictory_lists';

  if (claims.p === PURPOSE_UNSUB) {
    // One link, one list. A Legislative Watch footer link can never touch
    // News Watch, because the token it carries structurally cannot name it.
    if (optIn.length !== 0 || optOut.length !== 1) return 'bad_scope';
  } else if (optIn.length < 1) {
    return 'bad_scope';
  }
  return null;
}

/**
 * Mint a token. `lists` is { optIn: string[], optOut: string[] }.
 * `allowed` is the slug allowlist (see LIST_SLUGS in _lists.js).
 * Returns the token string, or throws on a programming error.
 */
export async function mintToken(secret, { purpose, email, optIn = [], optOut = [], ttl, now, allowed }) {
  const issued = typeof now === 'number' ? now : Math.floor(Date.now() / 1000);
  const lifetime = typeof ttl === 'number'
    ? ttl
    : (purpose === PURPOSE_UNSUB ? UNSUB_TTL_S : CONFIRM_TTL_S);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);

  const claims = {
    v: TOKEN_VERSION,
    p: purpose,
    e: normalizeEmail(email),
    i: optIn.slice(),
    o: optOut.slice(),
    t: issued,
    x: lifetime > 0 ? issued + lifetime : 0,
    n: b64urlEncode(nonce),
  };

  const bad = checkClaims(claims, allowed);
  if (bad) throw new Error(`refusing to mint an invalid token: ${bad}`);

  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const mac = await sign(secret, payload);
  if (!mac) throw new Error('refusing to mint a token without a signing key');
  return `${payload}.${b64urlEncode(mac)}`;
}

/**
 * Verify a token. Returns { ok: true, claims } or { ok: false, reason }.
 *
 * `purpose` is REQUIRED and is checked against the token's own purpose, so a
 * confirm token presented at /api/unsubscribe is rejected before anything
 * happens, and vice versa.
 */
export async function verifyToken(secret, token, { purpose, allowed, now }) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing_token' };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, sigText] = parts;
  if (!B64URL_RE.test(payload) || !B64URL_RE.test(sigText)) return { ok: false, reason: 'malformed' };

  // Authenticate BEFORE parsing. Attacker-controlled JSON never reaches
  // JSON.parse unless it was signed with the chapter's key.
  const given = b64urlDecode(sigText);
  if (!given || given.length !== 32) return { ok: false, reason: 'bad_signature' };
  const want = await sign(secret, payload);
  if (!want) return { ok: false, reason: 'not_configured' };
  if (!equalBytes(given, want)) return { ok: false, reason: 'bad_signature' };

  const raw = b64urlDecode(payload);
  if (!raw) return { ok: false, reason: 'malformed' };
  let claims;
  try {
    claims = JSON.parse(dec.decode(raw));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const bad = checkClaims(claims, allowed);
  if (bad) return { ok: false, reason: bad };
  if (claims.p !== purpose) return { ok: false, reason: 'wrong_purpose' };

  const at = typeof now === 'number' ? now : Math.floor(Date.now() / 1000);
  if (claims.x !== 0 && at >= claims.x) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      version: claims.v,
      purpose: claims.p,
      email: claims.e,
      optIn: claims.i == null ? [] : claims.i.slice(),
      optOut: claims.o == null ? [] : claims.o.slice(),
      issued: claims.t,
      expires: claims.x,
      nonce: claims.n,
    },
  };
}
