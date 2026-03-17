import { describe, it, expect } from 'vitest';
import { validateTemplateSafety, sanitizeCss } from '../../src/lib/server/template-renderer.js';

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
