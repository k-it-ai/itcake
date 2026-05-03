const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }> = {
	'image/png': { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
	'image/jpeg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
	'image/webp': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
	'application/pdf': { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }
};

export function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
	const sig = MAGIC_BYTES[mimeType];
	if (!sig) return false;
	if (buffer.length < sig.offset + sig.bytes.length) return false;
	if (!sig.bytes.every((b, i) => buffer[sig.offset + i] === b)) return false;
	if (mimeType === 'image/webp') {
		if (buffer.length < 12) return false;
		if (buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50) return false;
	}
	// (PDFs legitimately carry HTML-like strings in content streams; PNG/
	// scan rejects honest receipts and produces nothing for security beyond
	// `Content-Type: application/pdf` and `nosniff` on responses.
	return true;
}
