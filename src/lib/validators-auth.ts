import { z } from 'zod';

export const loginSchema = z.object({
	email: z.string().max(254).email(),
	password: z.string().min(1).max(72), // bcryptjs silently truncates at 72 bytes
	mfaCode: z.string().min(1).max(50).optional(),
	mfaToken: z.string().max(500).optional()
});

export const mfaInitSchema = z.object({
	currentPassword: z.string().min(1).max(72)
});

export const mfaEnableSchema = z.object({
	currentPassword: z.string().min(1).max(72),
	secret: z.string().regex(/^[A-Z2-7]{16,64}$/, 'Invalid secret format'),
	code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
	recoveryCodes: z.array(z.string().min(1).max(32)).length(10)
});

export const mfaDisableSchema = z.object({
	currentPassword: z.string().min(1).max(72),
	code: z.string().min(6).max(50)
});

const passwordField = z.string().min(8, 'Password must be at least 8 characters').max(72)
	.refine(p => /[a-z]/.test(p), { message: 'Password must include a lowercase letter' })
	.refine(p => /[A-Z]/.test(p), { message: 'Password must include an uppercase letter' })
	.refine(p => /[0-9]/.test(p), { message: 'Password must include a number' });

export const registerSchema = z.object({
	email: z.string().max(254).email(),
	name: z.string().min(1).max(200),
	password: passwordField,
	company: z.object({
		name: z.string().min(1).max(200),
		email: z.string().max(254).email().optional()
	}).optional()
});

export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, 'Current password is required').max(72),
	newPassword: passwordField,
	mfaCode: z.string().min(1).max(50).optional()
});
