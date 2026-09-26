// Knox DSA link shortener, backed by Cloudflare KV.
//
// GET /go/<slug>  ->  302 redirect to the URL stored under <slug> in the LINKS
// KV namespace. The point: printed flyers, tabling cards, and slides can all
// point at stable short links like knoxvilledsa.org/go/signal, and when the
// Signal invite or donation URL changes you edit ONE KV entry in the Cloudflare
// dashboard, no code change and no reprinting.
//
// Inert by default: with no LINKS namespace bound, or an unknown/mistyped slug,
// it simply redirects to the homepage. So deploying this changes nothing until
// you create the namespace and add entries. See functions/README.md for setup.

const FALLBACK = "/";

function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const home = new URL(FALLBACK, request.url).toString();
  const slug = String((params && params.slug) || "").trim().toLowerCase();

  if (!env.LINKS || !slug) {
    return Response.redirect(home, 302);
  }

  const target = await env.LINKS.get(slug);
  if (!isHttpUrl(target)) {
    // Unknown slug, or a value that is not a real URL: send them somewhere safe.
    return Response.redirect(home, 302);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store" },
  });
}
