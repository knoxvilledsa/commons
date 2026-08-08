// The XSS test for the generated contact-form template. RUN IT BEFORE PUBLISHING.
//
//   cd stack/commons/public && node functions/api/_house_theme.test.mjs
//
// (or with the project toolchain, after ./dsa site-bootstrap)
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE PYTHON CHECKS
//
// src/letterhead/snippet.py already asserts, at generation time, that every slot
// sits in a text position and that the escape table matches Python's
// html.escape(quote=True). Those are real checks, but they test a TRANSLITERATION
// of the JavaScript. This runs the actual shipped function in an actual JS engine,
// which is the only thing that proves the shipped function behaves.
//
// It matters more here than anywhere else in the chapter's mail. Everywhere else
// the input is a feed or an officer; here it is an anonymous, unauthenticated
// stranger on the public internet, and the output lands in the chapter's own inbox.
// So this is the one place a hand-written escape is on the hot path, and it gets
// its own test rather than a comment saying it looked right.

import { houseEscape, renderNotice } from './_house_theme.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
  }
};

// --- 1. houseEscape must equal Python's html.escape(quote=True) -------------
// Same corpus as NASTY in src/letterhead/snippet.py, with the answers Python
// gives. If these two lists ever disagree, the generator's equivalence assertion
// and this test are testing different things and one of them is lying.
const CASES = [
  ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['" onload="alert(1)', '&quot; onload=&quot;alert(1)'],
  ["' onmouseover='alert(1)", '&#x27; onmouseover=&#x27;alert(1)'],
  ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
  ['&lt;already escaped&gt;', '&amp;lt;already escaped&amp;gt;'],
  ['a & b < c > d " e \' f',
   'a &amp; b &lt; c &gt; d &quot; e &#x27; f'],
  ['&#x27;&amp;', '&amp;#x27;&amp;amp;'],
  ['', ''],
];
for (const [input, want] of CASES) {
  const got = houseEscape(input);
  check(`escape ${JSON.stringify(input)}`, got === want,
        `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
}

// The ampersand must be replaced FIRST, or every other replacement gets
// double-escaped. This is the classic ordering bug.
check('ampersand replaced first (no double escaping)',
      houseEscape('<') === '&lt;');

// null and undefined must not become the strings "null"/"undefined" in a
// chapter's inbox.
check('null renders empty', houseEscape(null) === '');
check('undefined renders empty', houseEscape(undefined) === '');

// --- 2. no injected markup survives into the document ----------------------
const hostile = {
  topic: 'A general question',
  name: '<script>alert("name")</script>',
  email: '"><script>alert(1)</script>',
  ip: '1.2.3.4',
  message: '</pre><script>alert(document.cookie)</script><img src=x onerror=1>',
};
const { html, text } = renderNotice(hostile);

check('no raw <script> anywhere in the html', !/<script/i.test(html));

// An event handler is only dangerous INSIDE a tag. Correctly escaped text that
// reads "onerror=1" is inert, because the < and > around it are &lt; and &gt;,
// so no element exists for an attribute to hang on.
//
// The two assertions this replaces grepped for the bare substrings "onerror="
// and "onload=" ANYWHERE in the document. No correctly escaped output that
// contains the word could ever satisfy that, and the hostile fixture below
// deliberately contains "onerror=1", so the onerror check failed from the day
// it was written; the onload check passed only because nothing injects an
// onload. Neither was ever executed (the authoring box had no Node), which is
// exactly what this file was added to catch. Verified 2026-07-26: the escaping
// itself is correct, and the rendered output carries the payload as
// "&lt;img src=x onerror=1&gt;".
//
// Matching handlers in real tags is both correct AND stricter than what it
// replaces, since it covers every on* handler rather than two spelled-out ones.
const HANDLER_IN_TAG = /<[^>]*\bon[a-z]+\s*=/i;
check('no event handler survives inside any tag', !HANDLER_IN_TAG.test(html));

// Positive control. A matcher that never fires would make the check above pass
// for the wrong reason, so prove it catches live handlers and ignores escaped
// ones before trusting its verdict on the real document.
check('the handler matcher catches a genuinely live handler',
      HANDLER_IN_TAG.test('<img src=x onerror=alert(1)>')
      && HANDLER_IN_TAG.test('<div ONLOAD = "x">')
      && !HANDLER_IN_TAG.test('&lt;img src=x onerror=1&gt;'),
      'the handler matcher is broken, so the assertion above proves nothing');
check('the injected script is present but escaped',
      html.includes('&lt;script&gt;'));
check('no javascript: url', !/javascript:/i.test(html));

// The document must still be the house template, not a wreck.
check('document opens as html', html.startsWith('<!DOCTYPE html>'));
check('document closes', html.trimEnd().endsWith('</html>'));

// Every tag in the document must be one the letterhead emits. An injected
// closing tag would show up here as a stray.
const ALLOWED = new Set([
  'html', 'head', 'meta', 'title', 'style', 'body', 'div', 'table', 'tbody',
  'tr', 'td', 'th', 'pre', 'span', 'a', 'br', 'img', 'p',
]);
for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
  check(`tag <${m[1]}> is one the letterhead emits`,
        ALLOWED.has(m[1].toLowerCase()), 'unexpected tag from injected content');
}

// --- 3. the text half is unaffected and complete ---------------------------
check('text half carries the message', text.includes('alert(document.cookie)'));
check('text half names the topic', text.includes('A general question'));

// --- 4. the artifact carries no send capability ----------------------------
const source = await (await import('node:fs/promises'))
  .readFile(new URL('./_house_theme.js', import.meta.url), 'utf8');
check('no resend endpoint in the artifact', !source.includes('api.resend.com'));
check('no recipient literal in the artifact', !/@knoxvilledsa\.org/.test(source));
check('the acknowledgement refusal is documented',
      source.includes('Do NOT add an acknowledgement'));

if (failures) {
  console.error(`\n${failures} failure(s). Do NOT publish.`);
  process.exit(1);
}
console.log('_house_theme.js: escaping, injection, text half and capability all pass');
