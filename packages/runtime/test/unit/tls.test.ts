import { Duplex } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { certificate, checkServerIdentity, createTls, identityRefusal } from '../../src/nodejs/tls';

// A connection still connecting, whose writes are dropped.
function connecting() {
  return Object.assign(
    new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { connecting: true },
  );
}

// A certificate for example.com, *.test.example.com, 10.0.0.1, ::1 and
// a@example.com (C=DE, O=Example, CN=example.com; self-signed).
const PEM = `
MIICDzCCAbSgAwIBAgIUaKhilWRzuJaFaou/ZVKZ8jOsCiowCgYIKoZIzj0EAwIw
NTELMAkGA1UEBhMCREUxEDAOBgNVBAoMB0V4YW1wbGUxFDASBgNVBAMMC2V4YW1w
bGUuY29tMB4XDTI2MTAyMDE4MTI0MFoXDTM2MTAxNzE4MTI0MFowNTELMAkGA1UE
BhMCREUxEDAOBgNVBAoMB0V4YW1wbGUxFDASBgNVBAMMC2V4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdNgC6KFDwZ/T64M+pedDDeUMuFjNG2rX
XHdvtFV0hNSdTXpYgoQsRfg97SgDiOeUhKEOrmzWhU+zzIS5QqcIFaOBoTCBnjAd
BgNVHQ4EFgQUd5VcW49xSMF66qBSGccE1LPwKT8wHwYDVR0jBBgwFoAUd5VcW49x
SMF66qBSGccE1LPwKT8wUQYDVR0RBEowSIILZXhhbXBsZS5jb22CEioudGVzdC5l
eGFtcGxlLmNvbYcECgAAAYcQAAAAAAAAAAAAAAAAAAAAAYENYUBleGFtcGxlLmNv
bTAJBgNVHRMEAjAAMAoGCCqGSM49BAMCA0kAMEYCIQCThKdqfKcvBS2PaX9hdR6p
UPIlR9+sjBFjeNgDwMTUyAIhAPBE4oGHqcTdZr/NVfTJltNxWxTqrLFkwhTQ780a
1tYG`;
const DER = new Uint8Array(Buffer.from(PEM.replace(/\s/g, ''), 'base64'));

describe("a peer's certificate", () => {
  test('has its subject, issuer and altnames, as Node words them', () => {
    const cert = certificate([DER]);
    expect(cert.subject).toEqual({ C: 'DE', O: 'Example', CN: 'example.com' });
    expect(cert.issuer).toEqual({ C: 'DE', O: 'Example', CN: 'example.com' });
    expect(cert.subjectaltname).toBe(
      'DNS:example.com, DNS:*.test.example.com, IP Address:10.0.0.1, ' +
        'IP Address:0:0:0:0:0:0:0:1, email:a@example.com',
    );
  });
});

describe('checkServerIdentity', () => {
  const cert = certificate([DER]);
  const check = (host: string) =>
    (checkServerIdentity(host, cert) as (Error & { code: string }) | undefined)?.code;

  test('passes a name or an address the certificate gives', () => {
    for (const host of ['example.com', 'EXAMPLE.com.', 'a.test.example.com', '10.0.0.1', '::1'])
      expect(check(host)).toBeUndefined();
  });

  test('refuses one it does not', () => {
    for (const host of ['test.example.com', 'a.b.test.example.com', 'other.com', '10.0.0.2'])
      expect(check(host)).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  test('refuses a certificate without names', () => {
    expect(checkServerIdentity('example.com', {})).toMatchObject({
      reason: 'Cert does not contain a DNS name',
    });
  });

  test('goes by the CN without altnames', () => {
    expect(checkServerIdentity('example.com', { subject: { CN: 'example.com' } })).toBeUndefined();
    expect(checkServerIdentity('other.com', { subject: { CN: 'example.com' } })).toMatchObject({
      reason: "Host: other.com. is not cert's CN: example.com",
    });
  });
});

describe("a caller's checkServerIdentity", () => {
  const pinned = (host: string, cert: { subject?: { CN?: unknown } }) =>
    cert.subject?.CN === 'pinned.example' ? undefined : new Error(`not pinned: ${host}`);

  test('refuses a certificate rustls authorized, by the servername', () => {
    const refusal = identityRefusal({ refused: null, chain: [DER] }, '10.0.0.1', {
      servername: 'example.com',
      checkServerIdentity: pinned,
    });
    expect(refusal?.message).toBe('not pinned: example.com');
  });

  test('says nothing of one rustls refused, or without a check', () => {
    expect(
      identityRefusal({ refused: 'expired', chain: [DER] }, 'example.com', {
        checkServerIdentity: pinned,
      }),
    ).toBeUndefined();
    expect(identityRefusal({ refused: null, chain: [DER] }, 'example.com', {})).toBeUndefined();
  });
});

describe('a connection closed before the handshake', () => {
  test("is Node's ECONNRESET", async () => {
    const tls = createTls({ module: { isIP: () => 0 } } as never, null, {});
    const raw = connecting();
    const socket = tls.connect({ socket: raw as never, host: 'example.com' });
    const error = new Promise<Error & { code?: string }>((resolve) => socket.on('error', resolve));
    let ended = false;
    socket.on('end', () => (ended = true));
    raw.push(null);
    raw.destroy();
    expect(await error).toMatchObject({
      code: 'ECONNRESET',
      message: 'Client network socket disconnected before secure TLS connection was established',
    });
    expect(ended).toBe(false);
  });
});

describe('TLSSocket', () => {
  test("is Node's (socket, options)", () => {
    const tls = createTls({ module: { isIP: () => 0 } } as never, null, {});
    const socket = new tls.TLSSocket(connecting(), { servername: 'example.com' });
    expect(socket.servername).toBe('example.com');
    expect(socket.encrypted).toBe(true);
    socket.destroy();
  });
});
