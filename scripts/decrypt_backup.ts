#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createDecipheriv } from 'crypto';
import { gunzipSync } from 'zlib';
import { resolve, basename } from 'path';

function printUsage(): void {
  console.log(`
Usage: npm run decrypt <encrypted-file> <password>

Decrypts a backup file (.csv.enc) created by the bot.

Arguments:
  <encrypted-file>  Path to the .csv.enc file (e.g., ./trades_backup_2026-09-16_14-30-00.csv.enc)
  <password>        The BACKUP_PASSWORD used for encryption

Example:
  npm run decrypt ./trades_backup_2026-09-16_14-30-00.csv.enc mysecretpassword

Output:
  Creates a decrypted .csv file in the same directory.
`);
}

function deriveKey(password: string): Buffer {
  return Buffer.from(password.padEnd(32).slice(0, 32));
}

function decryptFile(encryptedFilePath: string, password: string): string {
  if (!existsSync(encryptedFilePath)) {
    throw new Error(`File not found: ${encryptedFilePath}`);
  }

  const encryptedBuffer = readFileSync(encryptedFilePath);
  
  if (encryptedBuffer.length < 16) {
    throw new Error('Invalid encrypted file: too short (missing IV)');
  }

  const iv = encryptedBuffer.subarray(0, 16);
  const encryptedData = encryptedBuffer.subarray(16);

  const key = deriveKey(password);
  
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}. Wrong password?`);
  }

  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(decrypted);
  } catch (error) {
    throw new Error(`Decompression failed: ${error instanceof Error ? error.message : String(error)}. Data may be corrupted.`);
  }

  const outputFileName = basename(encryptedFilePath).replace('.enc', '');
  const outputPath = resolve(encryptedFilePath, '..', outputFileName);
  
  writeFileSync(outputPath, decompressed);
  
  return outputPath;
}

function main(): void {
  const args = process.argv.slice(2);
  
  if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(args.includes('-h') || args.includes('--help') ? 0 : 1);
  }

  const [encryptedFile, password] = args;

  try {
    console.log(`Decrypting: ${encryptedFile}`);
    const outputPath = decryptFile(encryptedFile, password);
    console.log(`✅ Successfully decrypted to: ${outputPath}`);
    console.log(`📄 You can now open the CSV file: ${basename(outputPath)}`);
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();