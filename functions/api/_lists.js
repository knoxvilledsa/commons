// The chapter's mailing lists, and the only three Resend calls this feature makes.
//
// WHY SLUGS AND NOT RESEND IDS IN THE TOKEN
//
// A token names a list by SLUG ("legislative"), never by its Resend identifier.
// The slug is resolved to an identifier here, from an environment variable, at
// the moment of the call. That buys four things:
//
//   1. The Python senders (Stage 2) mint tokens against a short, stable,
//      human-auditable name rather than a UUID they would have to carry.
//   2. Re-creating a list in Resend does not invalidate every unsubscribe token
//      already sitting in people's inboxes. Change one env var instead.
//   3. No account identifier travels in a URL, a mail header, or a browser
//      history.
//   4. Blast radius. Even a forged token, with a leaked signing key, can only
//      ever name one of the three slugs below. It cannot address an arbitrary
//      list in the chapter's Resend account, because an unknown slug is
//      rejected before any request is built.
//
// WHY TOPICS AND NOT AUDIENCES
//
// The plan for this work said "Audiences". Resend's API reference now carries
// the notice "Audiences are deprecated in favor of Segments. These endpoints
// still work, but will be removed in the future." Topics, not Segments, are the
// primitive that actually models a per-list subscription preference: each Topic
// has a per-contact state of opt_in or opt_out, which is exactly the state this
// feature turns on and off. Segments are query-defined groupings, which is a
// different thing. So this builds on Topics.
//
// If that turns out to be wrong for how the chapter's Resend account is set up,
// the change is contained: only setTopics() and the env var names below move.
// The token format does not, because it never mentions Resend at all.
//
// WHAT THIS FILE DELIBERATELY NEVER DOES
//
// It never sends the contact-level `unsubscribed` field, on any call. That flag
// is Resend's GLOBAL "unsubscribed from all Broadcasts" switch. Writing it from
// here would mean one list's unsubscribe silently muting another list, or a
// re-subscribe quietly overriding a global opt-out the person set themselves.
// Per-topic state is the only state this feature manages, and that invariant is
// asserted in _subscribe_token.test.mjs.

const API = 'https://api.resend.com';

export const LISTS = {
  legislative: {
    env: 'RESEND_TOPIC_LEGISLATIVE',
    label: 'Legislative Watch',
  },
  'news-aggressive': {
    env: 'RESEND_TOPIC_NEWS_AGGRESSIVE',
    label: 'News Watch, the daily temperature',
  },
  'news-passive': {
    env: 'RESEND_TOPIC_NEWS_PASSIVE',
    label: 'News Watch, only real developments',
  },
};

export const LIST_SLUGS = Object.keys(LISTS);

// The two News Watch modes are one choice, not two lists. Subscribing to one
// opts out of the other, and the opt-out is carried in the signed token rather
// than inferred at confirm time.
export const NEWS_MODES = ['news-aggressive', 'news-passive'];

/** Resolve slugs to Resend topic ids. Returns { ids, missing }. */
export function resolveTopics(env, slugs) {
  const ids = {};
  const missing = [];
  for (const slug of slugs) {
    const spec = LISTS[slug];
    if (!spec) {
      missing.push(slug);
      continue;
    }
    const id = String(env[spec.env] || '').trim();
    if (!id) missing.push(slug);
    else ids[slug] = id;
  }
  return { ids, missing };
}

// A SEPARATE credential from RESEND_API_KEY, on purpose. Mutating a contact's
// topics needs a Resend key with account-level (full) access; sending mail
// needs only a sending-scoped key. contact.js and the confirm-email send in
// subscribe.js use the narrower sending key. Reusing that key here would mean
// a single leaked secret at the Cloudflare edge exposes the whole contact
// list, not just the ability to send as the chapter. Keep this binding read
// by nothing else in this codebase.
function auth(env) {
  return {
    authorization: `Bearer ${env.RESEND_CONTACTS_API_KEY}`,
    'content-type': 'application/json',
  };
}

/**
 * Make sure the address exists as a contact. Idempotent by intent: an address
 * that is already a contact is not an error here, it is the normal case for
 * anyone subscribing to a second list. Deliberately sends only `email` (see the
 * header note about the global `unsubscribed` flag).
 *
 * Returns true on success or on "already exists", false on a real failure.
 */
export async function ensureContact(env, email) {
  let res;
  try {
    res = await fetch(`${API}/contacts`, {
      method: 'POST',
      headers: auth(env),
      body: JSON.stringify({ email }),
    });
  } catch {
    return false;
  }
  if (res.ok) return true;
  // 401/403 is a real credential problem and must not be swallowed. 422/409 and
  // friends are what a duplicate looks like, and the topics PATCH that follows
  // is what actually sets the state, so a duplicate is fine to continue past.
  if (res.status === 401 || res.status === 403 || res.status >= 500) return false;
  return true;
}

/**
 * Set this contact's subscription state on specific topics.
 *
 * `entries` is [{ slug, subscription }] where subscription is 'opt_in' or
 * 'opt_out'. Only the topics named are touched; Resend leaves every other topic
 * alone. Returns true on success.
 *
 * CALL THIS ONLY FROM A HANDLER THAT HAS ALREADY VERIFIED A SIGNED TOKEN.
 * This is the one function in the feature that can change what somebody
 * receives, so the right to call it is the right to unsubscribe any address
 * whose spelling you can guess. Its callers are confirm.js and unsubscribe.js,
 * and in both the entries come from verified claims via entriesFromClaims().
 * subscribe.js, the only unauthenticated entry point, does not import it, and
 * _subscribe_token.test.mjs asserts that it does not.
 */
export async function setTopics(env, email, entries) {
  if (entries.length === 0) return true;
  const { ids, missing } = resolveTopics(env, entries.map((e) => e.slug));
  if (missing.length) return false;

  const body = entries.map((e) => ({
    id: ids[e.slug],
    subscription: e.subscription,
  }));

  let res;
  try {
    res = await fetch(`${API}/contacts/${encodeURIComponent(email)}/topics`, {
      method: 'PATCH',
      headers: auth(env),
      body: JSON.stringify(body),
    });
  } catch {
    return false;
  }
  return res.ok;
}

/** Build the setTopics() entries for a verified token's claims. */
export function entriesFromClaims(claims) {
  return [
    ...claims.optIn.map((slug) => ({ slug, subscription: 'opt_in' })),
    ...claims.optOut.map((slug) => ({ slug, subscription: 'opt_out' })),
  ];
}
