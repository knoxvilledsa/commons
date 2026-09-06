# Cloudflare Pages Functions for the Knox DSA site

Serverless endpoints that deploy alongside the static prototype (Cloudflare builds anything under `functions/` automatically). Everything here is designed to be inert until you provision its binding, so dropping the folder into a deploy changes nothing on the live site until you turn a feature on.

## Mailing lists: `/api/subscribe`, `/api/confirm`, `/api/unsubscribe`

Double opt-in signup and one-click unsubscribe for Legislative Watch and News Watch, backed by Resend as the contact store. `subscribe.js` validates the address and mails a signed confirm link, and does nothing else at all: it writes no contact and no topic state, so a signup nobody confirms leaves no trace and a signup submitted in somebody else's name cannot change the state that person already had. `confirm.js` verifies that link and is the only place an opt-in is ever written; `unsubscribe.js` handles both the visible footer link (`GET`) and the RFC 8058 one-click button mail clients render (`POST`), and only the `POST` writes: the `GET` verifies the token and renders a one-button confirmation page, because corporate mail scanners fetch every link in a message before the human ever sees it and a `GET` that acted would opt those recipients out silently (2026-09-02 review).

That division is the security property to preserve. The only endpoint anyone can reach without a signed token is the one that cannot change anybody's subscription, in either direction. An earlier draft had `subscribe.js` pre-write every requested topic as `opt_out`, which meant ticking a box on a public form with a real subscriber's address unsubscribed them on the spot, straight past the token scheme. `_subscribe_token.test.mjs` now asserts against the source that `subscribe.js` imports neither `ensureContact` nor `setTopics` and names no Resend endpoint but the send one.

The signed token is defined in `_subscribe_token.js`. Read the `TOKEN_FORMAT` block at the top of that file before touching anything: the two Python senders mint the same tokens for the `List-Unsubscribe` header, so the format is a cross-language contract. `_subscribe_token.test.mjs` asserts the JavaScript against known-answer vectors produced by the Python side.

These suites now RUN ON THEIR OWN, so nothing here depends on a human remembering. `npm test` in `stack/commons/public` runs all of them (`functions/api/*.test.mjs` plus `src/lib/*.test.mjs`); `src/publish_site.sh` runs the same command between `npm ci` and the astro build, so a failure stops the publish with nothing pushed, including an unattended content republish; and `./dsa check` runs it too when the pinned project-local Node is installed. Run one by hand while you are working on it:

```
. bin/node-env.sh && npm test                                  # all of them
. bin/node-env.sh && node functions/api/_subscribe_token.test.mjs   # just one
```

### One-time setup (a human does this, in the dashboards)

1. In Resend, create three Topics, each with `default_subscription` set to `opt_out`: Legislative Watch, News Watch aggressive, News Watch passive. `opt_out` is immutable after creation, and it is what makes an unconfirmed signup receive nothing.
2. Generate a signing key with at least 32 bytes of randomness, for example `openssl rand -base64 32`. It is used as an opaque string, not decoded.
3. Add these to the Pages project under Settings > Environment variables, for BOTH production and preview. The four marked secret must be stored as encrypted secrets, never as plain variables and never in this repo.

   | Name | Kind | What it is |
   | --- | --- | --- |
   | `SUBSCRIBE_HMAC_KEY` | secret | signs and verifies every token |
   | `RESEND_API_KEY` | secret | already set for the contact form; sending-scoped, used here only to send the confirm email |
   | `RESEND_CONTACTS_API_KEY` | secret | a SEPARATE, full-access Resend key, used only to create/update contacts and topics. Must not be the same value as `RESEND_API_KEY`: a leak of a full-access key is "read the whole subscriber list," not "send mail as us," and giving the sending path that blast radius for no reason is exactly the mistake to avoid. |
   | `TURNSTILE_SECRET` | secret | already set for the contact form |
   | `RESEND_TOPIC_LEGISLATIVE` | plain | Topic id for Legislative Watch |
   | `RESEND_TOPIC_NEWS_AGGRESSIVE` | plain | Topic id for the daily temperature |
   | `RESEND_TOPIC_NEWS_PASSIVE` | plain | Topic id for real developments only |
   | `SITE_ORIGIN` | plain, optional | confirm link origin, defaults to `https://knoxvilledsa.org` |
   | `SUBSCRIBE_FROM` | plain, optional | From address, falls back to `CONTACT_FROM` |

4. Bind the existing `CONTACT_KV` namespace. No new namespace is needed: the throttles and the single-use confirm nonces live under their own `sub:` and `unsub:` key prefixes. This binding is REQUIRED, not optional: `/api/subscribe` and `/api/confirm` both answer `503 not_configured` without it, because the alternative is a public form that can send mail with nothing counting it and a confirm link with no single-use enforcement. A KV failure mid-request is still tolerated, deliberately; a binding that was never made is not.
5. Set the sender-side half on the machine that runs the legislative monitor and news watch, in `~/.config/knoxdsa/legislative-monitor.env` at mode 0600 (both jobs read that one file). `src/legislative_monitor/send_digest.py` and `src/dsa_news/send.py` now read their reader lists from the Topics above and mint the `List-Unsubscribe` token themselves, so five variables have to match what Cloudflare has:

   | Name | Must match Cloudflare? | Why the sender needs it |
   | --- | --- | --- |
   | `SUBSCRIBE_HMAC_KEY` | YES, exactly | signs the `List-Unsubscribe` token the edge verifies. A different value here means every unsubscribe link the chapter mails is dead, silently. |
   | `RESEND_CONTACTS_API_KEY` | same permission, need not be the same key | reads the contact list and each contact's topic state to build the recipient list. The sending-only `RESEND_API_KEY` cannot do this; it is a separate variable in the senders too, for the same blast-radius reason as at the edge. |
   | `RESEND_TOPIC_LEGISLATIVE` | YES | which Topic the bulletin list is |
   | `RESEND_TOPIC_NEWS_AGGRESSIVE` | YES | which Topic the noisy brief's list is |
   | `RESEND_TOPIC_NEWS_PASSIVE` | YES | which Topic the quiet brief's list is |

   Also create `~/.config/knoxdsa/dsa-news-operator.txt` at mode 0600 with the operator's own address. The news watch's failure alert used to be addressed to the aggressive reader list, on the reasoning that that list was the operator by construction; with a public sign-up form that is no longer true, so the alert has its own list now and there is deliberately no fallback. The legislative monitor's equivalent (`legislative-monitor-operator.txt`) already exists and likewise no longer falls back to the bulletin list.

6. Migrate the people already on the hand-curated lists into Resend, once the Topics and both keys above exist: `python3 src/migrate_subscribers_to_resend.py` (dry run; prints counts, writes nothing) then `python3 src/migrate_subscribers_to_resend.py --apply` (writes for real). Run this by hand, once, as the operator; see the script's own docstring for why this is not something to automate. The old flat files are only read, never modified or deleted, by this step.

   With any of these unset the senders refuse and say which one, rather than mailing a public list with no way off it. Two Python tests pin the token format against the same known-answer vector the JavaScript test uses, so run both after any change to either half:

   ```
   PYTHONPATH=src python3 src/test_email_render.py
   . stack/commons/public/bin/node-env.sh && (cd stack/commons/public && npm test)
   ```

With any of the secrets, the topic ids, or the `CONTACT_KV` binding unset, `/api/subscribe` answers `503 not_configured` exactly as the contact form does, and the other two refuse rather than half-work: a browser lands on the page's `status=error` state, a JSON caller gets a `503`. `/api/subscribe` requires `RESEND_CONTACTS_API_KEY` to be present even though it never uses it, because that is what `/api/confirm` needs to finish the job; mailing somebody a link that cannot work is worse than refusing the signup.

One more thing the code will not do for you: `/api/subscribe` sends at most ONE confirm email per address per hour, whoever asks and from wherever. That is a rule from the endpoint's policy entry, and the reasoning for taking it as a flat rate rather than as "skip the email if they are already subscribed" is in the `EMAIL_LIMIT` comment. The short version is that answering faster for an address that is already on a list turns the form into a membership oracle.

### The confirm email is generated, not written here

`subscribe.js` sends the chapter's real branded confirmation, from `_confirm_theme.js`. That file is generated: `src/confirm_snippet.py` renders `src/confirm_email.py` through the real Python bulletin skin and emits it as a template string with one `{{confirm_url}}` slot, exactly the way `src/letterhead/snippet.py` produces `_house_theme.js` for the contact form. `./dsa check` fails if either goes stale, so the copy a member reads and the copy the chapter approved cannot drift apart.

Edit the words in `src/confirm_email.py`, never in the `.js`, then:

```
./dsa email-snippet --write     # rewrites both generated templates
. bin/node-env.sh && node functions/api/_confirm_theme.test.mjs
```

Two things about that artifact are worth knowing before changing it. Its one slot is a URL and sits inside an `href`, which `_house_theme.js` deliberately has none of, so `renderConfirm()` puts the value through a scheme gate (the JS mirror of `letterhead.markup.link`) before the shared `houseEscape`, and refuses outright rather than mailing a confirmation nobody can act on. And it is rendered with the logo forced OFF: the masthead's logo is an inline CID attachment, this Function attaches nothing, and `assets/logos/` is gitignored, so leaving it on would mean both a broken image in every confirm email and an artifact that differed between checkouts.

### Still outstanding before this can go live

The endpoint's entry in `stack/MCP_AND_AUTOMATION_POLICY.md` Section 5. This is the one place in the chapter's mail where the recipient comes from the request, which is a deliberate exception to the rule the rest of the automation is built on, and Bobby signs it rather than the code asserting it.

## Link shortener: `/go/<slug>`

`go/[slug].js` redirects a short link to a URL you store in a Cloudflare KV namespace. Change the destination by editing one KV entry in the dashboard, no code change and no reprinting flyers.

### One-time setup

1. Create the KV namespace (dashboard: Workers & Pages > KV > Create, name it `LINKS`; or CLI: `wrangler kv namespace create LINKS`).
2. Bind it to the Pages project as `LINKS` (dashboard: your Pages project > Settings > Functions > KV namespace bindings), for BOTH production and preview environments. The binding variable name must be exactly `LINKS`.
3. Add entries: in the KV namespace, add key/value pairs where the key is the slug (lowercase) and the value is the full destination URL. Examples:
   - `signal` -> `https://signal.group/#...`
   - `donate` -> `https://secure.actblue.com/donate/knoxdsa`
   - `join` -> `https://actionnetwork.org/forms/join-knoxville-dsa`

### Usage

Print or share `https://<site>/go/signal`. Any unknown or mistyped slug, or an unconfigured namespace, redirects to the homepage rather than erroring. The endpoint only ever reads KV and redirects; it never writes, so it is safe.

### Notes

- Slugs are matched case-insensitively.
- Only `http(s)` destination values are honored (guards against a malformed KV entry).
- To repoint every printed link at once (for example a rotated Signal invite), edit the one KV value.
