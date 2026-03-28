/**
 * Shared file type verification via magic bytes.
 * Used by logo upload and receipt upload endpoints.
 */

// Magic byte signatures for file type verification
const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }> = {
	'image/png': { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
	'image/jpeg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
	'image/webp': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
	'application/pdf': { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }
};

const DANGEROUS_CONTENT = [
	Buffer.from('<?php'),
	Buffer.from('<?='),
	Buffer.from('<script'),
	Buffer.from('<%'),
];

export function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
	const sig = MAGIC_BYTES[mimeType];
	if (!sig) return false;
	if (buffer.length < sig.offset + sig.bytes.length) return false;
	if (!sig.bytes.every((b, i) => buffer[sig.offset + i] === b)) return false;
	if (mimeType === 'image/webp') {
		if (buffer.length < 12) return false;
		if (buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50) return false;
	}
	for (const sig of DANGEROUS_CONTENT) {
		if (buffer.includes(sig)) return false;
	}
	return true;
}
