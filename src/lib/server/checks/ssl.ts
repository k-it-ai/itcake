import tls from 'node:tls';
import { resolveTarget } from './validate-target.js';

interface SslResult {
	expiryDate: string;
	daysRemaining: number;
}

export async function checkSsl(hostname: string, timeoutMs = 10000): Promise<SslResult> {
	const pinnedIp = await resolveTarget(hostname);

	return new Promise((resolve, reject) => {
		// Intentional: expiry monitoring must read expired, self-signed, and
		// otherwise untrusted certificates instead of failing the probe.
		// codeql[js/disabling-certificate-validation]
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
