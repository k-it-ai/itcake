/**
 * Minimal IMAP reader for the live SMTP test.
 *
 * Ethereal stores sent messages in the account's INBOX, but the app's send
 * endpoint intentionally returns no message id, so the only way to assert on
 * the delivered bytes is to read the mailbox. Pulling in a full IMAP client
 * for one assertion would add a supply-chain surface to the project; this
 * helper speaks just enough IMAP4rev1 (LOGIN, SELECT, FETCH) over TLS with
 * certificate validation enabled.
 */
import tls from 'node:tls';

export interface ImapAccount {
	host: string;
	port: number;
	user: string;
	pass: string;
}

interface PendingCommand {
	tag: string;
	lines: string[];
	literals: string[];
	resolve: (literals: string[]) => void;
	reject: (err: Error) => void;
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Logs in, selects INBOX, and returns the raw RFC 822 source of every message.
 * The mailbox is read with BODY.PEEK[] so messages are not marked as seen.
 */
export function fetchImapMessages(
	account: ImapAccount,
	opts: { timeoutMs?: number } = {}
): Promise<string[]> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	return new Promise((resolve, reject) => {
		const socket = tls.connect({
			host: account.host,
			port: account.port,
			servername: account.host,
			rejectUnauthorized: true
		});

		let buffer = Buffer.alloc(0);
		let sequence = 0;
		let greeted = false;
		let current: PendingCommand | null = null;
		let settled = false;
		let resolveGreeting: () => void = () => {};
		let rejectGreeting: (err: Error) => void = () => {};
		const greeting = new Promise<void>((res, rej) => {
			resolveGreeting = res;
			rejectGreeting = rej;
		});

		const timer = setTimeout(() => {
			fail(new Error(`IMAP fetch timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();

		function fail(err: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			reject(err);
		}

		function succeed(messages: string[]): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(messages);
		}

		function pump(): void {
			for (;;) {
				const crlf = buffer.indexOf('\r\n');
				if (crlf < 0) return;
				const line = buffer.subarray(0, crlf).toString('utf8');

				// A line ending in {n} is followed by exactly n raw bytes (the
				// message body). Consume the literal together with its line.
				const literal = line.match(/\{(\d+)\}$/);
				if (literal) {
					const length = Number(literal[1]);
					if (buffer.length < crlf + 2 + length) return;
					const body = buffer.subarray(crlf + 2, crlf + 2 + length).toString('utf8');
					buffer = buffer.subarray(crlf + 2 + length);
					if (current) {
						current.lines.push(line);
						current.literals.push(body);
					}
					continue;
				}

				buffer = buffer.subarray(crlf + 2);

				if (!greeted) {
					if (!line.startsWith('* OK')) {
						rejectGreeting(new Error(`unexpected IMAP greeting: ${line}`));
						return;
					}
					greeted = true;
					resolveGreeting();
					continue;
				}

				if (!current) continue;
				current.lines.push(line);
				if (!line.startsWith(`${current.tag} `)) continue;

				const done = current;
				current = null;
				if (line.startsWith(`${done.tag} OK`)) done.resolve(done.literals);
				else done.reject(new Error(`IMAP ${done.tag} failed: ${line}`));
			}
		}

		function command(name: string, args: string): Promise<string[]> {
			return new Promise((res, rej) => {
				sequence += 1;
				const tag = `A${sequence}`;
				current = { tag, lines: [], literals: [], resolve: res, reject: rej };
				socket.write(`${tag} ${name}${args ? ` ${args}` : ''}\r\n`);
			});
		}

		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			pump();
		});
		socket.on('error', fail);
		socket.on('close', () => {
			if (!settled && !greeted) fail(new Error('IMAP connection closed before greeting'));
		});

		void (async () => {
			try {
				await greeting;
				await command('LOGIN', `${quote(account.user)} ${quote(account.pass)}`);
				await command('SELECT', 'INBOX');
				const messages = await command('FETCH', '1:* (BODY.PEEK[])');
				await command('LOGOUT', '');
				succeed(messages);
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		})();
	});
}
