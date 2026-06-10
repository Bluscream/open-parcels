import crypto from "node:crypto";

// The encryption key should be exactly 32 bytes for AES-256-GCM.
// We get this from an environment variable (e.g. hex encoded or base64)
// Fallback is a randomly generated key for dev, but this means restarts invalidate credentials!
let encryptionKey: Buffer;

const getEncryptionKey = (): Buffer => {
	if (encryptionKey) return encryptionKey;

	if (process.env.ENCRYPTION_KEY) {
		encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
		if (encryptionKey.length !== 32) {
			throw new Error(
				"ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters) for AES-256",
			);
		}
	} else {
		console.warn(
			"WARNING: No ENCRYPTION_KEY provided in env. Generating a random one. Credentials will be lost on restart!",
		);
		encryptionKey = crypto.randomBytes(32);
	}
	return encryptionKey;
};

const ALGORITHM = "aes-256-gcm";

export function encryptCredential(text: string): string {
	const key = getEncryptionKey();
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(text, "utf8", "hex");
	encrypted += cipher.final("hex");
	const authTag = cipher.getAuthTag().toString("hex");

	// Format: iv:authTag:encryptedData
	return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptCredential(encryptedData: string): string {
	const key = getEncryptionKey();
	const parts = encryptedData.split(":");

	if (parts.length !== 3) {
		throw new Error("Invalid encrypted data format");
	}

	const iv = Buffer.from(parts[0], "hex");
	const authTag = Buffer.from(parts[1], "hex");
	const encryptedText = parts[2];

	const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encryptedText, "hex", "utf8");
	decrypted += decipher.final("utf8");

	return decrypted;
}
