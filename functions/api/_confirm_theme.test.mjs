// The XSS test for the generated confirm email. RUN IT BEFORE PUBLISHING.
//
//   cd stack/commons/public && node functions/api/_confirm_theme.test.mjs
//
// (or with the project toolchain, after ./dsa site-bootstrap)
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE PYTHON CHECKS
//
// src/confirm_snippet.py asserts at generation time that the one slot is the
// whole value of a double-quoted href, that it appears exactly once, and that no
// CID attachment reference survived. Those are real checks on the TEMPLATE. This
// runs the shipped function in a real JS engine, which is the only thing that
// proves the SUBSTITUTION is safe.
//
// It matters here for the same reason it matters for the contact form, one step
// removed: the value being substituted is a URL this function built, not one a
// stranger typed, so today the escaping is defence in depth rather than the only
// thing standing between a stranger and the chapter's markup. Tests are for the
// edit that has not happened yet.

import { houseLink, renderConfirm } from './_confirm_theme.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
  }
};

// --- 1. houseLink is letterhead.markup.link ---------------------------------
// Same corpus as the `bad` list in src/letterhead/test_letterhead.py, plus the
// good ones. If these two disagree, the same URL is a link in one half of the
// chapter's mail and inert in the other.
for (const good of ['http://example.invalid/a', 'https://example.invalid/a',
                    'HTTPS://EXAMPLE.INVALID/A']) {
  check(`link keeps ${good}`, houseLink(good) === good);
}
for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AAAA',
                   'file:///etc/passwd', ' javascript:alert(1)', '', null,
                   undefined, '//example.invalid/a', 'jAvAsCrIpT:alert(1)']) {
  check(`link drops ${JSON.stringify(bad)}`, houseLink(bad) === '',
        `got ${JSON.stringify(houseLink(bad))}`);
}

// --- 2. A hostile URL never becomes markup ----------------------------------
const HOSTILE = [
  'https://example.invalid/a" onload="alert(1)',
  'https://example.invalid/a"><script>alert(1)</script>',
  "https://example.invalid/a' onmouseover='alert(1)",
  'https://example.invalid/a&<>"\'',
];
for (const url of HOSTILE) {
  const { html } = renderConfirm(url);
  // Exactly one anchor, and its href is one quoted attribute that ends where
  // the template says it does.
  const anchors = [...html.matchAll(/<a\s+href="([^"]*)"/g)];
  check(`one anchor for ${JSON.stringify(url)}`, anchors.length === 1,
        `got ${anchors.length}`);
  check(`no raw quote escaped out of the href for ${JSON.stringify(url)}`,
        !anchors[0][1].includes('"'));
  // The handler text survives INSIDE the escaped attribute value, which is the
  // correct outcome: it is data there, not an attribute. So strip every quoted
  // value before looking for one, which is what asks the real question, "did
  // anything become part of the document's structure?"
  const skeleton = html.replace(/"[^"]*"/g, '""');
  check(`no injected element for ${JSON.stringify(url)}`,
        !/<script/i.test(skeleton) && !/\bon[a-z]+\s*=/i.test(skeleton),
        skeleton.slice(skeleton.search(/<a\s/), 200));
}

// --- 3. A URL that will not pass the scheme gate is refused, not rendered ---
for (const url of ['javascript:alert(1)', '', 'ftp://example.invalid/a']) {
  let threw = false;
  try { renderConfirm(url); } catch { threw = true; }
  check(`refuses ${JSON.stringify(url)}`, threw);
}

// --- 4. The template is fully substituted and self-consistent ---------------
const real = 'https://knoxvilledsa.org/api/confirm?t=abc.def';
const out = renderConfirm(real);
check('no unfilled slot in the html', !out.html.includes('{{'));
check('no unfilled slot in the text', !out.text.includes('{{'));
check('the html links the real URL', out.html.includes(`href="${real}"`));
check('the text carries the real URL', out.text.includes(real));
check('there is a subject', typeof out.subject === 'string'
      && out.subject.length > 0);
// The edge attaches nothing, so a CID reference would be a broken image in
// every confirm email. Asserted in the generator too; asserted again on what
// actually ships.
check('no CID image reference', !out.html.includes('cid:'));
check('no remote asset', !/<img|background-image|@font-face|<link\b/i.test(out.html));

if (failures) {
  console.error(`\n_confirm_theme.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('_confirm_theme.js: link gate, escaping and substitution all pass');
