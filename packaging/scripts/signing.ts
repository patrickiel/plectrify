/**
 * Key generation and signing for the plugin catalogue.
 *
 * THE FORMAT. juce::RSAKey serialises as "part1,part2" in hex, and
 * applyToValue is a raw modular exponentiation: value = value^part1 mod part2.
 * So a JUCE public key is (exponent, modulus) and a JUCE private key is
 * (privateExponent, modulus) — which maps one-to-one onto an ordinary RSA
 * keypair. No JUCE build is needed to produce or use one.
 *
 * This is raw RSA over a SHA-256 digest, not RSASSA-PKCS1/PSS, because it has
 * to match what juce::RSAKey::applyToValue does on the verifying side. That is
 * fine for this job — the message is a fixed-length digest we compute
 * ourselves, so the padding-oracle and forgery concerns that make textbook RSA
 * dangerous for arbitrary messages do not arise — but it is the reason not to
 * reuse this module for anything else.
 *
 * WHERE THE PRIVATE HALF LIVES. Offline. Never in this repository, never in CI.
 * The catalogue is a list of binaries and the hashes that authorise them to be
 * loaded into the Plectrify process, so signing authority is code-execution
 * authority on every install.
 */
import { createHash, generateKeyPairSync, type JsonWebKey } from 'node:crypto';

/** Modular exponentiation by squaring. BigInt has no modPow, and the naive
 *  `x ** e % m` would materialise a number with millions of digits. */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;

  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }

  return result;
}

function base64UrlToBigInt(value: string): bigint {
  const hex = Buffer.from(value, 'base64url').toString('hex');
  return BigInt(`0x${hex}`);
}

/** Hex without a leading zero, matching juce::BigInteger::toString(16) so the
 *  value round-trips through parseString on the C++ side. */
function toJuceHex(value: bigint): string {
  const hex = value.toString(16);
  return hex.replace(/^0+/, '') || '0';
}

export interface CatalogueKeyPair {
  /** Paste into catalogueSigningKey() in Source/plugins/Catalogue.cpp. */
  publicKey: string;
  /** Write to an offline file. Never commit. */
  privateKey: string;
}

export function generateKeyPair(modulusLength = 2048): CatalogueKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength });

  const pub = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const priv = privateKey.export({ format: 'jwk' }) as JsonWebKey;

  const modulus = toJuceHex(base64UrlToBigInt(pub.n!));

  return {
    publicKey: `${toJuceHex(base64UrlToBigInt(pub.e!))},${modulus}`,
    privateKey: `${toJuceHex(base64UrlToBigInt(priv.d!))},${modulus}`,
  };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Signs a SHA-256 digest with a JUCE-format private key. Returns the signature
 * as hex, which is exactly what verifyManifestSignature() consumes.
 */
export function signDigest(digestHex: string, privateKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(digestHex)) {
    throw new Error('the digest must be a 64-character SHA-256 hex string.');
  }

  const parts = privateKey.trim().split(',');
  if (parts.length !== 2) {
    throw new Error('the key is not a comma-separated JUCE RSAKey pair.');
  }

  const exponent = BigInt(`0x${parts[0]}`);
  const modulus = BigInt(`0x${parts[1]}`);
  const digest = BigInt(`0x${digestHex}`);

  if (digest >= modulus) {
    throw new Error('the digest is not smaller than the modulus; the key is too short.');
  }

  return toJuceHex(modPow(digest, exponent, modulus));
}

/** The verifying half, mirroring verifyManifestSignature() in C++. Used by the
 *  publish script's post-condition so a catalogue nobody can verify is caught
 *  before it is left live. */
export function verifySignature(
  digestHex: string,
  signatureHex: string,
  publicKey: string,
): boolean {
  const parts = publicKey.trim().split(',');
  if (parts.length !== 2 || !signatureHex) return false;

  try {
    const recovered = modPow(
      BigInt(`0x${signatureHex}`),
      BigInt(`0x${parts[0]}`),
      BigInt(`0x${parts[1]}`),
    );
    return recovered === BigInt(`0x${digestHex}`);
  } catch {
    return false;
  }
}
