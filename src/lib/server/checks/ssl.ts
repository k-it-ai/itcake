import tls from 'node:tls';
import { resolveTarget } from './validate-target.js';

interface SslResult {
	expiryDate: string;
	daysRemaining: number;
}

export async function checkSsl(hostname: string, timeoutMs = 10000): Promise<SslResult> {
	const pinnedIp = await resolveTarget(hostname);

	return new Promise((resolve, reject) => {
		// Connect to pinned IP with servername for SNI — prevents DNS rebinding
		// rejectUnauthorized: false is safe here — this is a monitoring tool that needs to report
		// expiry dates even for already-expired or self-signed certificates. The connection is
		// DNS-pinned via resolveAndValidate() and we only read certificate metadata.
		// Pin TLS 1.2 explicitly so a Node started with `--tls-min-v1.0`
		// can't accept legacy ciphers when used as a monitoring probe. The
		// RDAP check sets the same; keep parity to avoid one-or-the-other
		// drift. rejectUnauthorized stays false because this is a monitor:
		// expired/self-signed certs must still report a date.
		const socket = tls.connect(443, pinnedIp, { servername: hostname, timeout: timeoutMs, rejectUnauthorized: false, minVersion: 'TLSv1.2' }, () => {
			const cert = socket.getPeerCertificate();
			socket.destroy();

			if (!cert || !cert.valid_to) {
				reject(new Error('No certificate returned'));
				return;
			}

			const expiryDate = new Date(cert.valid_to).toISOString().split('T')[0];
			const daysRemaining = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (86400 * 1000));
			resolve({ expiryDate, daysRemaining });
		});

		socket.on('error', (err) => {
			socket.destroy();
			reject(new Error(`TLS error: ${err.message.slice(0, 200)}`));
		});

		socket.on('timeout', () => {
			socket.destroy();
			reject(new Error('TLS connection timed out'));
		});
	});
}
