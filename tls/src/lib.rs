//! A TLS client for a Node.js process's `tls.connect` (packages/runtime/src/nodejs/tls.ts):
//! rustls without I/O of its own. The process feeds it the bytes its socket
//! read (`tls_feed`), writes what the program writes (`tls_write`), and sends what
//! it gives to send (`tls_take`); what the program reads comes from `tls_read`.
//!
//! A C-like API over handles, for JavaScript without wasm-bindgen: byte
//! arguments are (pointer, length) in this module's memory (`tls_alloc`,
//! `tls_free`); answers that are bytes go to one output buffer (`tls_out_ptr`,
//! `tls_out_len`), as do the messages of calls that fail (-1). Built for WASI,
//! whose `random_get` and `clock_time_get` the host gives (nodejs/tls.ts).

use std::cell::RefCell;
use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{ring, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    ClientConfig, ClientConnection, DigitallySignedStruct, ProtocolVersion, RootCertStore,
    SignatureScheme,
};

/// The roots' verifier, which with `reject` false lets a certificate it
/// refuses through and keeps why (Node's `rejectUnauthorized: false`, and
/// `authorizationError`).
#[derive(Debug)]
struct Verifier {
    inner: Arc<WebPkiServerVerifier>,
    reject: bool,
    refused: Arc<Mutex<Option<String>>>,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
        {
            Ok(verified) => Ok(verified),
            Err(error) => {
                *self.refused.lock().unwrap() = Some(error.to_string());
                if self.reject {
                    Err(error)
                } else {
                    Ok(ServerCertVerified::assertion())
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

struct Connection {
    tls: ClientConnection,
    // What the program has still to read, and whether the server closed
    // (close_notify).
    plain: Vec<u8>,
    closed: bool,
    refused: Arc<Mutex<Option<String>>>,
}

thread_local! {
    static CONNECTIONS: RefCell<Vec<Option<Connection>>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn answer(bytes: &[u8]) -> i32 {
    OUT.with(|out| {
        let mut out = out.borrow_mut();
        out.clear();
        out.extend_from_slice(bytes);
        out.len() as i32
    })
}

fn failed(message: impl ToString) -> i32 {
    answer(message.to_string().as_bytes());
    -1
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn with<T>(handle: i32, f: impl FnOnce(&mut Connection) -> T) -> Option<T> {
    CONNECTIONS.with(|all| {
        all.borrow_mut().get_mut(handle as usize).and_then(Option::as_mut).map(f)
    })
}

#[no_mangle]
pub extern "C" fn tls_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn tls_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn tls_out_ptr() -> *const u8 {
    OUT.with(|out| out.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn tls_out_len() -> usize {
    OUT.with(|out| out.borrow().len())
}

/// A connection to `name` (a host name or an address): ALPN's protocols in
/// their wire format (each after its length), whether to refuse a
/// certificate the roots do not vouch for, the roots in PEM (none:
/// Mozilla's), and a client certificate chain and its key in PEM (none:
/// no client authentication). Its handle, or -1.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn tls_client(
    name_ptr: *const u8,
    name_len: usize,
    alpn_ptr: *const u8,
    alpn_len: usize,
    reject: i32,
    ca_ptr: *const u8,
    ca_len: usize,
    cert_ptr: *const u8,
    cert_len: usize,
    key_ptr: *const u8,
    key_len: usize,
) -> i32 {
    match connect(
        bytes(name_ptr, name_len),
        bytes(alpn_ptr, alpn_len),
        reject != 0,
        bytes(ca_ptr, ca_len),
        bytes(cert_ptr, cert_len),
        bytes(key_ptr, key_len),
    ) {
        Ok(connection) => CONNECTIONS.with(|all| {
            let mut all = all.borrow_mut();
            let free = all.iter().position(Option::is_none).unwrap_or(all.len());
            if free == all.len() {
                all.push(None);
            }
            all[free] = Some(connection);
            free as i32
        }),
        Err(message) => failed(message),
    }
}

fn connect(
    name: &[u8],
    alpn: &[u8],
    reject: bool,
    ca: &[u8],
    cert: &[u8],
    key: &[u8],
) -> Result<Connection, String> {
    let provider = Arc::new(ring::default_provider());
    let mut roots = RootCertStore::empty();
    if ca.is_empty() {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    } else {
        for cert in CertificateDer::pem_slice_iter(ca) {
            roots.add(cert.map_err(|e| format!("ca: {e:?}"))?).map_err(|e| format!("ca: {e}"))?;
        }
    }
    let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(|e| e.to_string())?;
    let refused = Arc::new(Mutex::new(None));
    let verifier = Arc::new(Verifier { inner, reject, refused: refused.clone() });
    let builder = ClientConfig::builder_with_provider(provider as Arc<CryptoProvider>)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier);
    let mut config = if cert.is_empty() {
        builder.with_no_client_auth()
    } else {
        let chain = CertificateDer::pem_slice_iter(cert)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("cert: {e:?}"))?;
        let key = PrivateKeyDer::from_pem_slice(key).map_err(|e| format!("key: {e:?}"))?;
        builder.with_client_auth_cert(chain, key).map_err(|e| e.to_string())?
    };
    let mut at = 0;
    while at < alpn.len() {
        let len = alpn[at] as usize;
        config.alpn_protocols.push(alpn[at + 1..(at + 1 + len).min(alpn.len())].to_vec());
        at += 1 + len;
    }
    let name = std::str::from_utf8(name).map_err(|e| e.to_string())?;
    let name = ServerName::try_from(name.to_owned()).map_err(|e| e.to_string())?;
    let mut tls = ClientConnection::new(Arc::new(config), name).map_err(|e| e.to_string())?;
    // A write of any size: the process takes what it gives to send at once.
    tls.set_buffer_limit(None);
    Ok(Connection { tls, plain: Vec::new(), closed: false, refused })
}

/// What the socket read: the handshake goes on, the program's bytes wait
/// for `read`. 0, or -1 with why (an alert to `take` and send, then the
/// connection's end).
#[no_mangle]
pub unsafe extern "C" fn tls_feed(handle: i32, ptr: *const u8, len: usize) -> i32 {
    let mut input = bytes(ptr, len);
    with(handle, |c| {
        while !input.is_empty() {
            match c.tls.read_tls(&mut input) {
                // After close_notify: what follows is not read.
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => return failed(error),
            }
            if let Err(error) = c.tls.process_new_packets() {
                return failed(error);
            }
            let mut chunk = [0u8; 16384];
            loop {
                match c.tls.reader().read(&mut chunk) {
                    Ok(0) => {
                        c.closed = true;
                        break;
                    }
                    Ok(n) => c.plain.extend_from_slice(&chunk[..n]),
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(error) => return failed(error),
                }
            }
        }
        0
    })
    .unwrap_or_else(|| failed("no such connection"))
}

/// What the program writes (kept until the handshake is done).
#[no_mangle]
pub unsafe extern "C" fn tls_write(handle: i32, ptr: *const u8, len: usize) -> i32 {
    let data = bytes(ptr, len);
    with(handle, |c| match c.tls.writer().write_all(data) {
        Ok(()) => 0,
        Err(error) => failed(error),
    })
    .unwrap_or_else(|| failed("no such connection"))
}

/// What to send now, in the output buffer: its length.
#[no_mangle]
pub extern "C" fn tls_take(handle: i32) -> i32 {
    with(handle, |c| {
        let mut out = Vec::new();
        while c.tls.wants_write() {
            if let Err(error) = c.tls.write_tls(&mut out) {
                return failed(error);
            }
        }
        answer(&out)
    })
    .unwrap_or_else(|| failed("no such connection"))
}

/// What the program reads, in the output buffer: its length; -2 once the
/// server has closed and nothing is left.
#[no_mangle]
pub extern "C" fn tls_read(handle: i32) -> i32 {
    with(handle, |c| {
        if c.plain.is_empty() && c.closed {
            return -2;
        }
        let plain = std::mem::take(&mut c.plain);
        answer(&plain)
    })
    .unwrap_or_else(|| failed("no such connection"))
}

#[no_mangle]
pub extern "C" fn tls_handshaking(handle: i32) -> i32 {
    with(handle, |c| c.tls.is_handshaking() as i32).unwrap_or(-1)
}

/// The protocol ALPN chose, in the output buffer (empty: none).
#[no_mangle]
pub extern "C" fn tls_alpn(handle: i32) -> i32 {
    with(handle, |c| answer(c.tls.alpn_protocol().unwrap_or_default())).unwrap_or(-1)
}

/// The version agreed: 0x0303 (TLS 1.2), 0x0304 (TLS 1.3), or 0.
#[no_mangle]
pub extern "C" fn tls_version(handle: i32) -> i32 {
    with(handle, |c| match c.tls.protocol_version() {
        Some(ProtocolVersion::TLSv1_2) => 0x0303,
        Some(ProtocolVersion::TLSv1_3) => 0x0304,
        _ => 0,
    })
    .unwrap_or(0)
}

/// The cipher suite agreed (its IANA name), in the output buffer.
#[no_mangle]
pub extern "C" fn tls_cipher(handle: i32) -> i32 {
    with(handle, |c| {
        let name = c
            .tls
            .negotiated_cipher_suite()
            .and_then(|suite| suite.suite().as_str())
            .unwrap_or_default();
        answer(name.as_bytes())
    })
    .unwrap_or(-1)
}

/// The server's certificate chain, in the output buffer: each DER
/// certificate after its length (four bytes, big-endian).
#[no_mangle]
pub extern "C" fn tls_peer(handle: i32) -> i32 {
    with(handle, |c| {
        let mut out = Vec::new();
        for cert in c.tls.peer_certificates().unwrap_or_default() {
            out.extend_from_slice(&(cert.len() as u32).to_be_bytes());
            out.extend_from_slice(cert);
        }
        answer(&out)
    })
    .unwrap_or(-1)
}

/// Why the roots did not vouch for the server's certificate, in the
/// output buffer (empty: they did).
#[no_mangle]
pub extern "C" fn tls_refused(handle: i32) -> i32 {
    with(handle, |c| answer(c.refused.lock().unwrap().as_deref().unwrap_or("").as_bytes()))
        .unwrap_or(-1)
}

/// The program's end: close_notify, to `take` and send.
#[no_mangle]
pub extern "C" fn tls_close(handle: i32) {
    with(handle, |c| c.tls.send_close_notify());
}

#[no_mangle]
pub extern "C" fn tls_forget(handle: i32) {
    CONNECTIONS.with(|all| {
        if let Some(slot) = all.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}
