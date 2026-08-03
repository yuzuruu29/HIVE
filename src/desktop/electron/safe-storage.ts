import type { DesktopCredentialCipher } from "../credential-vault.js";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export class SafeStorageCredentialCipher implements DesktopCredentialCipher {
  public constructor(private readonly safeStorage: SafeStorageLike) {}

  public isEncryptionAvailable(): boolean { return this.safeStorage.isEncryptionAvailable(); }

  public encrypt(value: string): Uint8Array {
    if (!this.isEncryptionAvailable()) throw new Error("OS-backed safeStorage encryption is unavailable.");
    return this.safeStorage.encryptString(value);
  }

  public decrypt(value: Uint8Array): string {
    if (!this.isEncryptionAvailable()) throw new Error("OS-backed safeStorage decryption is unavailable.");
    return this.safeStorage.decryptString(value);
  }
}
