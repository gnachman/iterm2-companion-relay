// A fixed throwaway P-256 root used only by the attested-mode tests: its cert
// is bound as APPATTEST_ROOT_PEM (the relay's trust anchor under test), and its
// private key signs the synthetic intermediate so the test can mint chains the
// relay will accept. NOT Apple's root, NOT used in production.

export const TEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkzCCATmgAwIBAgIUTvhft+cZwhbSbChYLHOwMKZ3BOQwCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUVGVzdCBBcHAgQXR0ZXN0IFJvb3QwHhcNMjYwNjE0MDEwNzIw
WhcNMzYwNjExMDEwNzIwWjAfMR0wGwYDVQQDDBRUZXN0IEFwcCBBdHRlc3QgUm9v
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABKTSDN/bsT+mYt+EbhHVH0rspGZC
807Ff1nf7ehqlMzRR3rYrrQBvTDHw+grki5oZcGouGEIdTNnBj+PKpZJL8SjUzBR
MB0GA1UdDgQWBBTwkZ9bVo+8fAItWe55TjPTfBIgzDAfBgNVHSMEGDAWgBTwkZ9b
Vo+8fAItWe55TjPTfBIgzDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA
MEUCIFqQjI7nqjwJjf51BOwL/mp+iSLRJ2LfG8lQaLtMWXG8AiEA4K0Vlo7eTSEO
Bh/+OsyBkQQGFaY3xXFFFoutaXVL31s=
-----END CERTIFICATE-----`;

const TEST_ROOT_PK8_B64 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgajRiXH1A8e6+1nffdXkPEmV5aH3kr+BaYNilrIEQDNahRANCAASk0gzf27E/pmLfhG4R1R9K7KRmQvNOxX9Z3+3oapTM0Ud62K60Ab0wx8PoK5IuaGXBqLhhCHUzZwY/jyqWSS/E";

/// Import the root's private key as a CryptoKey for signing synthetic chains.
export async function testRootSigningKey() {
  const der = Uint8Array.from(atob(TEST_ROOT_PK8_B64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
