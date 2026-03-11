import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor() {
    const hexKey = process.env.ENCRYPTION_KEY || "";
    this.key = Buffer.from(hexKey, "hex");
    if (this.key.length !== 32) {
      throw new Error("ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
    }
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
  }

  decrypt(cipherText: string): string {
    const [ivHex, payloadHex] = cipherText.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const payload = Buffer.from(payloadHex, "hex");
    const decipher = createDecipheriv("aes-256-cbc", this.key, iv);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString("utf8");
  }

  maskSecret(secret: string): string {
    if (secret.length <= 6) {
      return "***";
    }
    return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
  }
}
