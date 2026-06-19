// Attested-mode admission (ATTEST_REQUIRED on, trust anchored at the test
// root). The phone earns a single-use ticket by attesting over a server
// challenge, then presents it in its WebSocket Proof; the mac parks without a
// ticket. Adversarial cases assert the gate: no ticket, a bogus ticket, a
// replayed challenge, and a wrong-origin attestation are all refused.

import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import * as x509 from "@peculiar/x509";
import { encode as cborEncode } from "../src/cbor.js";
import { TEST_ROOT_PEM, testRootSigningKey } from "./fixtures/testRoot.js";
import { admit, next, freshRoom, canonicalEncode, ORIGIN } from "./helpers.js";

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const APP_ID = "TEAMID12.com.example.app";

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function nonceExtensionDer(nonce) {
  const octet = concat(new Uint8Array([0x04, 0x20]), nonce);
  const ctx = concat(new Uint8Array([0xa1, octet.length]), octet);
  return concat(new Uint8Array([0x30, ctx.length]), ctx);
}

async function post(room, path, body) {
  const res = await SELF.fetch("https://relay.example" + path, {
    method: "POST",
    headers: { "x-relay-room": room, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Build an attestation over `challengeB64` signed up to the test root. `origin`
// defaults to the relay's; overriding it forges a wrong-origin clientDataHash.
async function buildAttestation(challengeB64, origin = ORIGIN) {
  x509.cryptoProvider.set(crypto);
  const root = new x509.X509Certificate(TEST_ROOT_PEM);
  const rootKey = await testRootSigningKey();
  const intKeys = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);
  const leafKeys = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);
  const notBefore = new Date("2020-01-01");
  const notAfter = new Date("2030-01-01");

  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02", subject: "CN=Int", issuer: root.subject,
    notBefore, notAfter, publicKey: intKeys.publicKey, signingKey: rootKey, signingAlgorithm: ALG,
  });
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", leafKeys.publicKey));
  const keyId = await sha256(publicKeyRaw);
  const rpIdHash = await sha256(new TextEncoder().encode(APP_ID));
  const aaguid = new Uint8Array(16);
  aaguid.set(new TextEncoder().encode("appattest"));
  const authData = concat(
    rpIdHash, new Uint8Array([0x40]), new Uint8Array([0, 0, 0, 0]),
    aaguid, new Uint8Array([0, keyId.length]), keyId);
  const clientDataHash = await sha256(canonicalEncode("iterm2-relay-attest", [b64ToBytes(challengeB64), new TextEncoder().encode(origin)]));
  const nonce = await sha256(concat(authData, clientDataHash));
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03", subject: "CN=Leaf", issuer: intermediate.subject,
    notBefore, notAfter, publicKey: leafKeys.publicKey, signingKey: intKeys.privateKey,
    signingAlgorithm: ALG,
    extensions: [new x509.Extension("1.2.840.113635.100.8.2", false, nonceExtensionDer(nonce).buffer)],
  });
  const attestationObject = cborEncode({
    fmt: "apple-appattest",
    attStmt: { x5c: [new Uint8Array(leaf.rawData), new Uint8Array(intermediate.rawData)], receipt: new Uint8Array([0]) },
    authData,
  });
  return { attestationObject: b64(attestationObject), leafKeys };
}

// raw(r||s) -> DER, so synthetic assertions ship the DER form Apple uses.
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

// An App Attest assertion signed by `keys` over a fresh challenge.
async function buildAssertion(keys, challengeB64, { appId = APP_ID, counter = 1, origin = ORIGIN } = {}) {
  const rpIdHash = await sha256(new TextEncoder().encode(appId));
  const counterBytes = new Uint8Array([
    (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff]);
  const authenticatorData = concat(rpIdHash, new Uint8Array([0x00]), counterBytes);
  const clientDataHash = await sha256(canonicalEncode("iterm2-relay-attest", [b64ToBytes(challengeB64), new TextEncoder().encode(origin)]));
  // Match real App Attest: sign over nonce = SHA256(authenticatorData ||
  // clientDataHash), so the ECDSA-SHA256 signature is over SHA256(nonce).
  const nonce = await sha256(concat(authenticatorData, clientDataHash));
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, nonce));
  return b64(cborEncode({ signature: rawToDer(rawSig), authenticatorData }));
}

async function getTicket(room) {
  const ch = await post(room, "/attest/challenge");
  expect(ch.status).toBe(200);
  const { attestationObject, leafKeys } = await buildAttestation(ch.body.challenge);
  const res = await post(room, "/attest", { challenge: ch.body.challenge, attestationObject });
  expect(res.status).toBe(200);
  return { ticket: res.body.ticket, leafKeys };
}

// Park a mac, attest+admit a phone, and return its registration token + the
// attested key (to sign the registration assertion).
async function attestedAdmit(room) {
  const { ticket, leafKeys } = await getTicket(room);
  await admit(room, "mac", () => ({}));
  const phone = await admit(room, "phone", () => ({ ticket }));
  expect(phone.result.ok).toBe(true);
  return { registrationToken: phone.result.registrationToken, leafKeys };
}

describe("attested-mode admission", () => {
  it("a valid ticket admits the phone, and the mac parks without one", async () => {
    const room = freshRoom();
    const { ticket } = await getTicket(room);
    const mac = await admit(room, "mac", () => ({})); // mac cannot attest; parks
    expect(mac.result.ok).toBe(true);
    const phone = await admit(room, "phone", () => ({ ticket }));
    expect(phone.result.ok).toBe(true);

    const got = next(mac.ws);
    phone.ws.send("over-attested-relay");
    expect(await got).toBe("over-attested-relay");
  });

  it("rejects a phone with no ticket", async () => {
    const room = freshRoom();
    await admit(room, "mac", () => ({}));
    const phone = await admit(room, "phone", () => ({}));
    expect(phone.result.ok).toBe(false);
  });

  it("rejects a bogus ticket", async () => {
    const room = freshRoom();
    await admit(room, "mac", () => ({}));
    const phone = await admit(room, "phone", () => ({ ticket: "not-a-real-ticket" }));
    expect(phone.result.ok).toBe(false);
  });

  it("a ticket is single-use", async () => {
    const room = freshRoom();
    const { ticket } = await getTicket(room);
    await admit(room, "mac", () => ({}));
    expect((await admit(room, "phone", () => ({ ticket }))).result.ok).toBe(true);
    // Reuse: the ticket was consumed.
    expect((await admit(room, "phone", () => ({ ticket }))).result.ok).toBe(false);
  });

  it("rejects /attest for a challenge that was never issued", async () => {
    const room = freshRoom();
    const { attestationObject } = await buildAttestation(b64(new Uint8Array(32)));
    const res = await post(room, "/attest", { challenge: b64(new Uint8Array(32)), attestationObject });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad challenge");
  });

  it("a challenge is single-use", async () => {
    const room = freshRoom();
    const ch = await post(room, "/attest/challenge");
    const { attestationObject } = await buildAttestation(ch.body.challenge);
    expect((await post(room, "/attest", { challenge: ch.body.challenge, attestationObject })).status).toBe(200);
    // Replaying the same challenge fails (it was deleted on first use).
    const replay = await post(room, "/attest", { challenge: ch.body.challenge, attestationObject });
    expect(replay.status).toBe(403);
  });

  it("rejects an attestation bound to the wrong origin", async () => {
    const room = freshRoom();
    const ch = await post(room, "/attest/challenge");
    const { attestationObject } = await buildAttestation(ch.body.challenge, "https://evil.example");
    const res = await post(room, "/attest", { challenge: ch.body.challenge, attestationObject });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("attestation rejected");
  });
});

describe("attested /register", () => {
  const VERIFIER = b64(new Uint8Array(32).fill(7));
  const freshChallenge = async (room) => (await post(room, "/attest/challenge")).body.challenge;

  it("registers with a valid assertion over a fresh challenge", async () => {
    const room = freshRoom();
    const { registrationToken, leafKeys } = await attestedAdmit(room);
    const challenge = await freshChallenge(room);
    const assertion = await buildAssertion(leafKeys, challenge, { counter: 3 });
    const res = await post(room, "/register", { registrationToken, verifier: VERIFIER, challenge, assertion });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects registration with no assertion", async () => {
    const room = freshRoom();
    const { registrationToken } = await attestedAdmit(room);
    const res = await post(room, "/register", { registrationToken, verifier: VERIFIER });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("assertion required");
  });

  it("rejects an assertion signed by a different key", async () => {
    const room = freshRoom();
    const { registrationToken } = await attestedAdmit(room);
    const challenge = await freshChallenge(room);
    const otherKeys = await crypto.subtle.generateKey(ALG, false, ["sign", "verify"]);
    const assertion = await buildAssertion(otherKeys, challenge);
    const res = await post(room, "/register", { registrationToken, verifier: VERIFIER, challenge, assertion });
    expect(res.status).toBe(403);
    // The error now carries the specific reason ("assertion rejected: ...").
    expect(res.body.error).toContain("assertion rejected");
  });

  it("rejects an assertion over a challenge that was never issued", async () => {
    const room = freshRoom();
    const { registrationToken, leafKeys } = await attestedAdmit(room);
    const fake = b64(new Uint8Array(32).fill(9));
    const assertion = await buildAssertion(leafKeys, fake);
    const res = await post(room, "/register", { registrationToken, verifier: VERIFIER, challenge: fake, assertion });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad challenge");
  });
});
