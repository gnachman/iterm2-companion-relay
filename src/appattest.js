// App Attest attestation verification (Apple's "apple-appattest" format), the
// gate that proves a genuine, unmodified iTerm2 Buddy build minted the key. It
// runs entirely on WebCrypto + @peculiar/x509 so it works in workerd. The trust
// root is a parameter (Apple's App Attest Root CA in production, a throwaway
// root in tests) so the full verification can be exercised with synthetic
// chains. Everything fails closed: any deviation throws AppAttestError.
//
// Steps (Apple's documented procedure):
//  1. CBOR-decode; fmt == "apple-appattest".
//  2. Verify the cert chain credCert <- intermediate <- trusted root, validity.
//  3. nonce == SHA256(authData || clientDataHash), compared to the nonce in the
//     credCert's Apple extension (OID 1.2.840.113635.100.8.2).
//  4. keyId == SHA256(credCert public key); equals the authData credentialId.
//  5. authData: rpIdHash == SHA256(appId); AAGUID matches the environment.
// Returns { keyId, publicKeyRaw } for the relay to pin and later verify
// assertions against.

import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { decode as cborDecode } from "./cbor.js";

const NONCE_OID = "1.2.840.113635.100.8.2";
// AAGUID bytes: ASCII tag zero-padded to 16. Distinguishes the production App
// Attest service from the development one; a dev attestation must not pass in a
// production-configured relay.
const AAGUID_PROD = textToAaguid("appattest");
const AAGUID_DEV = textToAaguid("appattestdevelop");

export class AppAttestError extends Error {}

export async function verifyAttestation({
  attestationObject,
  clientDataHash,
  appId,
  environment,
  trustedRootPem,
  now = new Date(),
}) {
  x509.cryptoProvider.set(crypto);

  let obj;
  try {
    obj = cborDecode(asBytes(attestationObject));
  } catch (e) {
    throw new AppAttestError(`malformed attestation CBOR: ${e.message}`);
  }
  if (obj.fmt !== "apple-appattest") throw new AppAttestError("unexpected attestation format");
  const attStmt = obj.attStmt;
  const authData = obj.authData;
  if (!attStmt || !(authData instanceof Uint8Array)) throw new AppAttestError("bad attestation shape");
  const x5c = attStmt.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 ||
      !(x5c[0] instanceof Uint8Array) || !(x5c[1] instanceof Uint8Array)) {
    throw new AppAttestError("missing or malformed certificate chain");
  }

  let credCert, intermediate, root;
  try {
    credCert = new x509.X509Certificate(x5c[0]);
    intermediate = new x509.X509Certificate(x5c[1]);
    root = new x509.X509Certificate(trustedRootPem);
  } catch (e) {
    throw new AppAttestError(`certificate parse failed: ${e.message}`);
  }

  // 2. Chain + validity. Trust is anchored at `root` (we verify the
  //    intermediate against ITS key, not the chain's own claimed root).
  for (const c of [credCert, intermediate]) {
    if (now < c.notBefore || now > c.notAfter) {
      throw new AppAttestError("certificate is expired or not yet valid");
    }
  }
  if (!(await intermediate.verify({ publicKey: await root.publicKey.export(crypto), signatureOnly: true }))) {
    throw new AppAttestError("intermediate not signed by the trusted root");
  }
  if (!(await credCert.verify({ publicKey: await intermediate.publicKey.export(crypto), signatureOnly: true }))) {
    throw new AppAttestError("leaf not signed by the intermediate");
  }

  // 3. Nonce.
  const expectedNonce = new Uint8Array(
    await crypto.subtle.digest("SHA-256", concat(authData, asBytes(clientDataHash))));
  const ext = credCert.getExtension(NONCE_OID);
  if (!ext) throw new AppAttestError("missing nonce extension");
  const certNonce = parseNonceExtension(new Uint8Array(ext.value));
  if (!equalBytes(certNonce, expectedNonce)) throw new AppAttestError("nonce mismatch");

  // 4. keyId.
  const credKey = await credCert.publicKey.export(crypto);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", credKey));
  const keyId = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyRaw));

  // 5. authData.
  if (authData.length < 37) throw new AppAttestError("authData too short");
  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appId)));
  if (!equalBytes(rpIdHash, expectedRpIdHash)) throw new AppAttestError("rpIdHash (app id) mismatch");

  const aaguid = authData.subarray(37, 53);
  const expectedAaguid = environment === "development" ? AAGUID_DEV : AAGUID_PROD;
  if (!equalBytes(aaguid, expectedAaguid)) {
    // Name the actual AAGUID so a mismatch is diagnosable: "appattest" is the
    // production attestation service, "appattestdevelop" the development one.
    const got = new TextDecoder().decode(aaguid).replace(/\0+$/, "");
    throw new AppAttestError(`AAGUID/environment mismatch: got "${got}", env="${environment}"`);
  }

  const credIdLen = (authData[53] << 8) | authData[54];
  const credentialId = authData.subarray(55, 55 + credIdLen);
  if (!equalBytes(credentialId, keyId)) throw new AppAttestError("credentialId does not match keyId");

  return { keyId, publicKeyRaw };
}

// Verify an App Attest ASSERTION (from generateAssertion): proves CURRENT
// possession of the attested key over a fresh server challenge. Distinct from
// attestation, no cert chain; the signature is checked against the public key
// pinned at attestation time. Returns { counter } (the authenticator sign count,
// which the caller enforces strictly-increasing per key id for replay defence).
export async function verifyAssertion({
  assertion,        // raw CBOR { signature: DER ECDSA, authenticatorData }
  clientDataHash,   // SHA256(challenge || origin)
  publicKeyRaw,     // 65-byte EC point pinned from the attestation
  appId,
}) {
  let obj;
  try {
    obj = cborDecode(asBytes(assertion));
  } catch (e) {
    throw new AppAttestError(`malformed assertion CBOR: ${e.message}`);
  }
  const signatureDer = obj.signature;
  const authenticatorData = obj.authenticatorData;
  if (!(signatureDer instanceof Uint8Array) || !(authenticatorData instanceof Uint8Array)) {
    throw new AppAttestError("bad assertion shape");
  }
  if (authenticatorData.length < 37) throw new AppAttestError("assertion authenticatorData too short");

  // Apple signs the assertion over nonce = SHA256(authenticatorData ||
  // clientDataHash). WebCrypto's ECDSA verify applies SHA-256 to whatever data
  // we pass, so we must pass the nonce itself (already a SHA-256 digest): the
  // Secure Enclave's signature is over SHA-256(nonce), i.e. a SHA-256 of the
  // SHA-256 of the concatenation. (Passing the bare concatenation would verify
  // one hash short, which silently "worked" only against the synthetic test.)
  // App Attest ships the signature in DER; WebCrypto wants IEEE-P1363 raw r||s.
  const nonce = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", concat(authenticatorData, asBytes(clientDataHash))));
  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw", asBytes(publicKeyRaw), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch (e) {
    throw new AppAttestError(`pinned key import failed: ${e.message}`);
  }
  const rawSig = derEcdsaToRaw(signatureDer, 32);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSig, nonce))) {
    throw new AppAttestError("assertion signature invalid");
  }

  const rpIdHash = authenticatorData.subarray(0, 32);
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appId)));
  if (!equalBytes(rpIdHash, expectedRpIdHash)) throw new AppAttestError("assertion rpIdHash mismatch");

  const counter = (authenticatorData[33] << 24) | (authenticatorData[34] << 16)
    | (authenticatorData[35] << 8) | authenticatorData[36];
  return { counter: counter >>> 0 };
}

// DER ECDSA signature SEQUENCE { INTEGER r, INTEGER s } -> fixed-width r||s.
function derEcdsaToRaw(der, size) {
  let pos = 0;
  if (der[pos++] !== 0x30) throw new AppAttestError("signature: expected SEQUENCE");
  ({ pos } = readDerLength(der, pos));
  const readInt = () => {
    if (der[pos++] !== 0x02) throw new AppAttestError("signature: expected INTEGER");
    let len;
    ({ len, pos } = readDerLength(der, pos));
    let val = der.subarray(pos, pos + len);
    pos += len;
    while (val.length > size && val[0] === 0x00) val = val.subarray(1); // drop sign-padding
    if (val.length > size) throw new AppAttestError("signature: integer too large");
    const out = new Uint8Array(size);
    out.set(val, size - val.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concat(r, s);
}

// The credCert nonce extension is DER: SEQUENCE { [1] EXPLICIT OCTET STRING }.
function parseNonceExtension(der) {
  let pos = 0;
  const expect = (tag) => {
    if (der[pos++] !== tag) throw new AppAttestError("nonce extension: unexpected DER tag");
    return readDerLength(der, pos);
  };
  ({ pos } = expect(0x30)); // SEQUENCE
  ({ pos } = expect(0xa1)); // [1] EXPLICIT
  let len;
  ({ len, pos } = expect(0x04)); // OCTET STRING
  if (len !== 32) throw new AppAttestError("nonce extension: bad nonce length");
  return der.subarray(pos, pos + 32);
}

function readDerLength(der, pos) {
  const first = der[pos++];
  if (first < 0x80) return { len: first, pos };
  const n = first & 0x7f;
  if (n === 0 || n > 4) throw new AppAttestError("nonce extension: bad DER length");
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | der[pos++];
  return { len, pos };
}

function textToAaguid(text) {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode(text));
  return out;
}

function asBytes(x) {
  return x instanceof Uint8Array ? x : new Uint8Array(x);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const _internals = { parseNonceExtension, AAGUID_PROD, AAGUID_DEV, NONCE_OID };
