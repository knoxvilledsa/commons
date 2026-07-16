# Cloudflare Pages Functions for the Knox DSA site

Serverless endpoints that deploy alongside the static prototype (Cloudflare builds anything under `functions/` automatically). Everything here is designed to be inert until you provision its binding, so dropping the folder into a deploy changes nothing on the live site until you turn a feature on.

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
