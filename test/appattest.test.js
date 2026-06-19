// App Attest verification, exercised with synthetic attestations: a throwaway
// root/intermediate/leaf chain we sign ourselves, fed through verifyAttestation
// with that root as the trust anchor. The adversarial cases assert the threat
// model, an attestation that lies about its app id, environment, challenge,
// chain, or root must be rejected.

import "reflect-metadata";
import { describe, it, expect, beforeAll } from "vitest";
import * as x509 from "@peculiar/x509";
import { encode as cborEncode } from "../src/cbor.js";
import { verifyAttestation, verifyAssertion, AppAttestError, _internals } from "../src/appattest.js";

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const APP_ID = "TEAMID12.com.example.app";

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function nonceExtensionDer(nonce) {
  const octet = concat(new Uint8Array([0x04, 0x20]), nonce);
  const ctx = concat(new Uint8Array([0xa1, octet.length]), octet);
  return concat(new Uint8Array([0x30, ctx.length]), ctx);
}

// Build a complete, valid attestation; options override fields to forge.
async function buildAttestation(opts = {}) {
  x509.cryptoProvider.set(crypto);
  const appId = opts.appId ?? APP_ID;
  const environment = opts.environment ?? "production";
  const aaguid = environment === "development" ? _internals.AAGUID_DEV : _internals.AAGUID_PROD;
  const clientDataHash = opts.clientDataHash ?? (await sha256(new TextEncoder().encode("challenge||origin")));
  const notBefore = opts.notBefore ?? new Date("2020-01-01");
  const notAfter = opts.notAfter ?? new Date("2030-01-01");

  const rootKeys = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);
  const intKeys = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);
  const leafKeys = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);

  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01", name: "CN=Test App Attest Root",
    notBefore, notAfter, signingAlgorithm: ALG, keys: rootKeys,
  });
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02", subject: "CN=Test Intermediate", issuer: root.subject,
    notBefore, notAfter, publicKey: intKeys.publicKey,
    signingKey: rootKeys.privateKey, signingAlgorithm: ALG,
  });

  // keyId = sha256(leaf public key raw point); authData carries it as the
  // credential id; the nonce commits to authData and the clientDataHash.
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", leafKeys.publicKey));
  const keyId = await sha256(publicKeyRaw);
  const rpIdHash = await sha256(new TextEncoder().encode(opts.authDataAppId ?? appId));
  const authData = concat(
    rpIdHash, new Uint8Array([0x40]), new Uint8Array([0, 0, 0, 0]),
    aaguid, new Uint8Array([0x00, keyId.length]), keyId);
  const nonce = await sha256(concat(authData, clientDataHash));

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03", subject: "CN=Test Leaf", issuer: intermediate.subject,
    notBefore, notAfter, publicKey: leafKeys.publicKey,
    // Forge: sign the leaf with the wrong key to break the chain.
    signingKey: (opts.leafSignedByWrongKey ? rootKeys : intKeys).privateKey,
    signingAlgorithm: ALG,
    extensions: [new x509.Extension(_internals.NONCE_OID, false, nonceExtensionDer(nonce).buffer)],
  });

  const attestationObject = cborEncode({
    fmt: opts.fmt ?? "apple-appattest",
    attStmt: { x5c: [new Uint8Array(leaf.rawData), new Uint8Array(intermediate.rawData)],
               receipt: new Uint8Array([0]) },
    authData,
  });

  const rootPem = root.toString("pem");
  return { attestationObject, clientDataHash, appId, environment, rootPem, keyId };
}

describe("verifyAttestation", () => {
  let valid;
  beforeAll(async () => { valid = await buildAttestation(); });

  it("accepts a valid attestation and returns the keyId", async () => {
    const result = await verifyAttestation({
      attestationObject: valid.attestationObject, clientDataHash: valid.clientDataHash,
      appId: valid.appId, environment: valid.environment, trustedRootPem: valid.rootPem,
    });
    expect([...result.keyId]).toEqual([...valid.keyId]);
    expect(result.publicKeyRaw.length).toBe(65);
  });

  it("rejects a wrong app id (rpIdHash mismatch)", async () => {
    await expect(verifyAttestation({
      attestationObject: valid.attestationObject, clientDataHash: valid.clientDataHash,
      appId: "OTHER.app", environment: valid.environment, trustedRootPem: valid.rootPem,
    })).rejects.toBeInstanceOf(AppAttestError);
  });

  it("rejects a development attestation when production is required", async () => {
    const dev = await buildAttestation({ environment: "development" });
    await expect(verifyAttestation({
      attestationObject: dev.attestationObject, clientDataHash: dev.clientDataHash,
      appId: dev.appId, environment: "production", trustedRootPem: dev.rootPem,
    })).rejects.toThrow(/AAGUID/);
  });

  it("rejects a mismatched clientDataHash (nonce/challenge mismatch)", async () => {
    await expect(verifyAttestation({
      attestationObject: valid.attestationObject,
      clientDataHash: await sha256(new TextEncoder().encode("a different challenge")),
      appId: valid.appId, environment: valid.environment, trustedRootPem: valid.rootPem,
    })).rejects.toThrow(/nonce/);
  });

  it("rejects an untrusted root (different anchor)", async () => {
    const other = await buildAttestation();
    await expect(verifyAttestation({
      attestationObject: valid.attestationObject, clientDataHash: valid.clientDataHash,
      appId: valid.appId, environment: valid.environment, trustedRootPem: other.rootPem,
    })).rejects.toThrow(/intermediate not signed/);
  });

  it("rejects a broken chain (leaf not signed by intermediate)", async () => {
    const forged = await buildAttestation({ leafSignedByWrongKey: true });
    await expect(verifyAttestation({
      attestationObject: forged.attestationObject, clientDataHash: forged.clientDataHash,
      appId: forged.appId, environment: forged.environment, trustedRootPem: forged.rootPem,
    })).rejects.toThrow(/leaf not signed/);
  });

  it("rejects an authData whose credentialId disagrees with the app id", async () => {
    // authData built for a different app id than the rpIdHash claims breaks the
    // rpIdHash check (the attacker cannot retarget a genuine attestation).
    const cross = await buildAttestation({ authDataAppId: "EVIL.app" });
    await expect(verifyAttestation({
      attestationObject: cross.attestationObject, clientDataHash: cross.clientDataHash,
      appId: cross.appId, environment: cross.environment, trustedRootPem: cross.rootPem,
    })).rejects.toThrow(/rpIdHash/);
  });

  it("rejects an expired chain", async () => {
    const expired = await buildAttestation({
      notBefore: new Date("2000-01-01"), notAfter: new Date("2000-02-01") });
    await expect(verifyAttestation({
      attestationObject: expired.attestationObject, clientDataHash: expired.clientDataHash,
      appId: expired.appId, environment: expired.environment, trustedRootPem: expired.rootPem,
    })).rejects.toThrow(/expired/);
  });

  it("rejects a wrong attestation format", async () => {
    const badFmt = await buildAttestation({ fmt: "fido-u2f" });
    await expect(verifyAttestation({
      attestationObject: badFmt.attestationObject, clientDataHash: badFmt.clientDataHash,
      appId: badFmt.appId, environment: badFmt.environment, trustedRootPem: badFmt.rootPem,
    })).rejects.toThrow(/format/);
  });
});

import { APPLE_APP_ATTEST_ROOT_PEM } from "../src/appleRoot.js";

describe("Apple App Attest root", () => {
  it("is a parseable certificate for Apple's App Attestation Root CA", () => {
    const cert = new x509.X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
    expect(cert.subject).toContain("Apple App Attestation Root CA");
    expect(cert.subject).toContain("Apple Inc.");
  });
});

// Minimal raw(r||s) -> DER ECDSA signature, so synthetic assertions ship the
// DER form Apple uses (verifyAssertion converts back).
function derInteger(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.subarray(i);
  if (v[0] & 0x80) v = concat(new Uint8Array([0x00]), v);
  return concat(new Uint8Array([0x02, v.length]), v);
}
function rawToDer(raw) {
  const body = concat(derInteger(raw.subarray(0, 32)), derInteger(raw.subarray(32, 64)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function buildAssertion({ clientDataHash, appId = APP_ID, counter = 1, keys } = {}) {
  keys = keys ?? await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const rpIdHash = await sha256(new TextEncoder().encode(appId));
  const counterBytes = new Uint8Array([
    (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff]);
  const authenticatorData = concat(rpIdHash, new Uint8Array([0x00]), counterBytes);
  // Match real App Attest: the Secure Enclave signs over
  // nonce = SHA256(authenticatorData || clientDataHash) (so the ECDSA-SHA256
  // signature is over SHA256(nonce)). Signing the bare concatenation would only
  // exercise the old one-hash-short bug.
  const nonce = await sha256(concat(authenticatorData, clientDataHash));
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, nonce));
  return { assertion: cborEncode({ signature: rawToDer(rawSig), authenticatorData }), publicKeyRaw, keys };
}

describe("verifyAssertion", () => {
  it("accepts a valid assertion and returns the counter", async () => {
    const clientDataHash = await sha256(new TextEncoder().encode("fresh-challenge||origin"));
    const a = await buildAssertion({ clientDataHash, counter: 7 });
    const res = await verifyAssertion({
      assertion: a.assertion, clientDataHash, publicKeyRaw: a.publicKeyRaw, appId: APP_ID });
    expect(res.counter).toBe(7);
  });

  it("rejects an assertion verified against a DIFFERENT key", async () => {
    const clientDataHash = await sha256(new TextEncoder().encode("c"));
    const a = await buildAssertion({ clientDataHash });
    const other = await buildAssertion({ clientDataHash });
    await expect(verifyAssertion({
      assertion: a.assertion, clientDataHash, publicKeyRaw: other.publicKeyRaw, appId: APP_ID,
    })).rejects.toThrow(/signature invalid/);
  });

  it("rejects an assertion over a different clientDataHash (challenge replay)", async () => {
    const a = await buildAssertion({ clientDataHash: await sha256(new TextEncoder().encode("c1")) });
    await expect(verifyAssertion({
      assertion: a.assertion, clientDataHash: await sha256(new TextEncoder().encode("c2")),
      publicKeyRaw: a.publicKeyRaw, appId: APP_ID,
    })).rejects.toThrow(/signature invalid/);
  });

  it("rejects an assertion whose app id does not match", async () => {
    const clientDataHash = await sha256(new TextEncoder().encode("c"));
    const a = await buildAssertion({ clientDataHash });
    await expect(verifyAssertion({
      assertion: a.assertion, clientDataHash, publicKeyRaw: a.publicKeyRaw, appId: "OTHER.app",
    })).rejects.toThrow(/rpIdHash/);
  });
});
