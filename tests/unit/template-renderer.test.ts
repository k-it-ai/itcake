import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-template-renderer');

let validateTemplateSafety: typeof import('../../src/lib/server/template-renderer.js').validateTemplateSafety;
let sanitizeCss: typeof import('../../src/lib/server/template-renderer.js').sanitizeCss;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'template-renderer.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/lib/server/template-renderer.js');
	validateTemplateSafety = m.validateTemplateSafety;
	sanitizeCss = m.sanitizeCss;
});

describe('validateTemplateSafety', () => {
	it('allows safe output tags', () => {
		expect(() => validateTemplateSafety('<%= document.name %>', 'test')).not.toThrow();
		expect(() => validateTemplateSafety('<%= t("hello") %>', 'test')).not.toThrow();
		expect(() => validateTemplateSafety('<%# comment %>', 'test')).not.toThrow();
	});

	it('blocks scriptlet tags', () => {
		expect(() => validateTemplateSafety('<% require("child_process") %>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%  process.exit() %>', 'test')).toThrow('unsafe EJS');
	});

	it('blocks unescaped output tags', () => {
		expect(() => validateTemplateSafety('<%- html %>', 'test')).toThrow('unsafe EJS');
	});

	it('blocks whitespace-slurp scriptlet tags', () => {
		expect(() => validateTemplateSafety('<%_ code() %>', 'test')).toThrow('unsafe EJS');
	});

	it('blocks Unicode whitespace bypass attempts', () => {
		expect(() => validateTemplateSafety('<%\u00A0process.exit()%>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%\u2000require("fs")%>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%\u3000code()%>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%\uFEFFcode%>', 'test')).toThrow('unsafe EJS');
	});

	it('blocks dangerous HTML tags', () => {
		expect(() => validateTemplateSafety('<script>alert(1)</script>', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<iframe src="x">', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<object data="x">', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<embed src="x">', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<svg onload="x">', 'test')).toThrow('blocked HTML');
	});

	it('blocks event handler attributes', () => {
		expect(() => validateTemplateSafety('<div onmouseover="x">', 'test')).toThrow('event handler');
		expect(() => validateTemplateSafety('<img onerror="x">', 'test')).toThrow('event handler');
	});


	it('blocks event handlers smuggled via > in quoted attribute (SANDBOX-002)', () => {
		expect(() => validateTemplateSafety('<div title=">" onclick=alert(1)>', 'test')).toThrow('event handler');
		expect(() => validateTemplateSafety("<div title='>' onmouseover=alert(1)>", 'test')).toThrow('event handler');
		expect(() => validateTemplateSafety('<details title=">" open ontoggle=while(true){}>', 'test')).toThrow('event handler');
	});

	it('blocks event handlers with multiple quoted attributes containing >', () => {
		expect(() => validateTemplateSafety('<div class="a>b" data-x="c>d" onclick=x>', 'test')).toThrow('event handler');
	});

	it('blocks disallowed identifiers in expressions', () => {
		expect(() => validateTemplateSafety('<%= constructor %>', 'test')).toThrow('disallowed identifier');
		expect(() => validateTemplateSafety('<%= process %>', 'test')).toThrow('disallowed identifier');
		expect(() => validateTemplateSafety('<%= require %>', 'test')).toThrow('disallowed identifier');
		expect(() => validateTemplateSafety('<%= global %>', 'test')).toThrow('disallowed identifier');
	});

	it('allows known-safe identifiers', () => {
		expect(() => validateTemplateSafety('<%= seller.name %>', 'test')).not.toThrow();
		expect(() => validateTemplateSafety('<%= totals.total %>', 'test')).not.toThrow();
		expect(() => validateTemplateSafety('<%= formatMoney(totals.total, currency) %>', 'test')).not.toThrow();
	});

	it('blocks bracket notation', () => {
		expect(() => validateTemplateSafety('<%= this["constructor"] %>', 'test')).toThrow('bracket notation');
	});

	it('allows brackets inside string literals', () => {
		expect(() => validateTemplateSafety("<%= t('[label]') %>", 'test')).not.toThrow();
	});

	it('blocks template literals (backticks)', () => {
		expect(() => validateTemplateSafety('<%= `${constructor}` %>', 'test')).toThrow('template literal');
	});

	it('blocks Unicode escapes', () => {
		expect(() => validateTemplateSafety('<%= \\u0063onstructor %>', 'test')).toThrow('Unicode escape');
	});

	it('strips null bytes', () => {
		expect(() => validateTemplateSafety('<scr\0ipt>alert(1)</script>', 'test')).toThrow('blocked HTML');
	});

	it('limits expression count', () => {
		const many = Array.from({ length: 501 }, (_, i) => `<%= item ${i} %>`).join('');
		expect(() => validateTemplateSafety(many, 'test')).toThrow('too many expressions');
	});

	it('limits expression length', () => {
		const long = `<%= ${'x'.repeat(201)} %>`;
		expect(() => validateTemplateSafety(long, 'test')).toThrow('exceeding 200 characters');
	});


	it('blocks NFC-decomposed identifiers that would bypass allowlist (SANDBOX-003)', () => {


		// The key security test: ensure the normalization step doesn't break existing checks.
		const decomposed = '<\u0073\u0063ript>alert(1)</script>'; // plain ASCII, should still be blocked
		expect(() => validateTemplateSafety(decomposed, 'test')).toThrow('blocked HTML');
	});

	it('normalizes Unicode whitespace around EJS tags before checking', () => {
		expect(() => validateTemplateSafety('<%\u200Bprocess.exit()%>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%\u2029code()%>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%\u202Fcode()%>', 'test')).toThrow('unsafe EJS');
		expect(() => validateTemplateSafety('<%\u205Fcode()%>', 'test')).toThrow('unsafe EJS');
	});


	it('blocks <video> tag (resource loading in Puppeteer)', () => {
		expect(() => validateTemplateSafety('<video src="https://evil.com/track.mp4"></video>', 'test')).toThrow('blocked HTML');
	});

	it('blocks <audio> tag (resource loading in Puppeteer)', () => {
		expect(() => validateTemplateSafety('<audio src="https://evil.com/track.mp3"></audio>', 'test')).toThrow('blocked HTML');
	});

	it('blocks <source> tag (media source element)', () => {
		expect(() => validateTemplateSafety('<source src="https://evil.com/x.mp4" type="video/mp4">', 'test')).toThrow('blocked HTML');
	});

	it('blocks <picture> tag (image source set)', () => {
		expect(() => validateTemplateSafety('<picture><source srcset="x.webp"></picture>', 'test')).toThrow('blocked HTML');
	});

	it('blocks <math> tag (MathML can embed scripts)', () => {
		expect(() => validateTemplateSafety('<math><mi>x</mi></math>', 'test')).toThrow('blocked HTML');
	});

	it('blocks <base> tag (URL hijacking)', () => {
		expect(() => validateTemplateSafety('<base href="https://evil.com/">', 'test')).toThrow('blocked HTML');
	});

	it('blocks <link> tag (stylesheet injection / resource loading)', () => {
		expect(() => validateTemplateSafety('<link rel="stylesheet" href="https://evil.com/x.css">', 'test')).toThrow('blocked HTML');
	});

	it('blocks <meta http-equiv> (redirect, CSP override)', () => {
		expect(() => validateTemplateSafety('<meta http-equiv="refresh" content="0;url=https://evil.com">', 'test')).toThrow('blocked HTML');
	});

	it('allows non-dangerous meta tags (charset, viewport)', () => {
		expect(() => validateTemplateSafety('<meta charset="utf-8">', 'test')).not.toThrow();
	});

	it('blocks tags with whitespace before their attributes', () => {
		expect(() => validateTemplateSafety('<script >alert(1)</script>', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<iframe  src="x">', 'test')).toThrow('blocked HTML');
	});

	it('blocks tag names case-insensitively', () => {
		expect(() => validateTemplateSafety('<SCRIPT>alert(1)</SCRIPT>', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<Video src="x">', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<AUDIO src="x">', 'test')).toThrow('blocked HTML');
	});


	it('strips HTML comments before checking tags', () => {
		expect(() => validateTemplateSafety('<!-- <script>alert(1)</script> --><div>safe</div>', 'test')).not.toThrow();
	});

	it('blocks tags that span across comment boundaries', () => {
		expect(() => validateTemplateSafety('<!-- comment --><script>alert(1)</script>', 'test')).toThrow('blocked HTML');
	});

	it('does not let abrupt empty-comment closers swallow live markup', () => {
		expect(() => validateTemplateSafety('<!--> <script>alert(1)</script>', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<!---> <script>alert(1)</script>', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<!--> <div onclick="x">', 'test')).toThrow('event handler');
	});

	it('treats --!> as a comment terminator before scanning', () => {
		expect(() => validateTemplateSafety('<!-- note --!> <script>alert(1)</script>', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<!-- note --!><div>safe</div>', 'test')).not.toThrow();
	});

	it('does not let a comment opener inside raw text hide live markup', () => {
		expect(() => validateTemplateSafety('<style><!--</style><script>alert(1)</script>-->', 'test')).toThrow('blocked HTML');
		expect(() => validateTemplateSafety('<textarea><script>alert(1)</script></textarea>', 'test')).not.toThrow();
	});

	it('sees attributes that follow a quoted EJS expression', () => {
		expect(() => validateTemplateSafety(
			'<div class="<%= clsx("a", "b") %>" onclick="x">',
			'test'
		)).toThrow('event handler');
	});
});

describe('sanitizeCss', () => {
	it('blocks @import', () => {
		expect(sanitizeCss('@import url("x.css");')).toContain('/* blocked */');
	});

	it('blocks @font-face', () => {
		expect(sanitizeCss('@font-face { src: url("x"); }')).toContain('/* blocked */');
	});

	it('blocks external url() but allows data:', () => {
		expect(sanitizeCss('background: url("https://example.com/x.png");')).toContain('blocked:');
		expect(sanitizeCss('background: url(data:image/png;base64,abc);')).not.toContain('blocked:');
	});

	it('blocks CSS expression()', () => {
		expect(sanitizeCss('width: expression(document.body.clientWidth);')).toContain('/* blocked */');
	});

	it('blocks </style> tag', () => {
		expect(sanitizeCss('</style><script>alert(1)</script>')).toContain('/* blocked */');
	});

	it('resolves CSS backslash escapes before checking', () => {
		expect(sanitizeCss('background: url(h\\74tp://example.com);')).toContain('blocked:');
	});
});
