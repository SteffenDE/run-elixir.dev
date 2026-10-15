defmodule Playground.Notifications.WebPush.Crypto do
  @moduledoc """
  The cryptography of Web Push, on nothing but `:crypto`.

    * `encrypt/4` encrypts a payload for one subscription, as the
      `aes128gcm` content coding of RFC 8188 with the keys of RFC 8291.
    * `vapid_header/3` identifies the application server to the push
      service, RFC 8292.

  Keys are raw P-256 keys: a public key is the 65 byte uncompressed point, a
  private key the 32 byte scalar. They travel base64url encoded without
  padding, which is what browsers hand out and expect.
  """

  @curve :prime256v1

  # One record holds the whole payload, and push services accept 4096 bytes of
  # body: 86 bytes of header, 16 of tag and 1 of padding delimiter leave this.
  @max_payload 3993
  @record_size 4096

  @doc """
  Generates a key pair, `{public_key, private_key}`.
  """
  def generate_keys, do: :crypto.generate_key(:ecdh, @curve)

  @doc """
  Returns the public key of a private key.
  """
  def public_key(private_key) do
    {public_key, _private_key} = :crypto.generate_key(:ecdh, @curve, private_key)
    public_key
  end

  @doc """
  Encrypts `payload` for the subscription with the public key `p256dh` and the
  secret `auth`, and returns the request body.

  The sender's key pair and the salt are fresh for every message; `:keys` and
  `:salt` fix them, for tests.
  """
  def encrypt(payload, p256dh, auth, opts \\ []) when byte_size(payload) <= @max_payload do
    {as_public, as_private} = Keyword.get_lazy(opts, :keys, &generate_keys/0)
    salt = Keyword.get_lazy(opts, :salt, fn -> :crypto.strong_rand_bytes(16) end)

    ecdh_secret = :crypto.compute_key(:ecdh, p256dh, as_private, @curve)
    key_info = "WebPush: info\0" <> p256dh <> as_public
    ikm = hkdf(auth, ecdh_secret, key_info, 32)

    cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
    nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0", 12)

    # 2 is the delimiter of the last record, which is the only one.
    {ciphertext, tag} =
      :crypto.crypto_one_time_aead(:aes_128_gcm, cek, nonce, payload <> <<2>>, "", true)

    <<salt::binary-16, @record_size::32, byte_size(as_public)::8, as_public::binary,
      ciphertext::binary, tag::binary>>
  end

  @doc """
  The largest payload `encrypt/4` takes.
  """
  def max_payload, do: @max_payload

  # Both of HKDF's steps; one block of expansion is all Web Push ever needs.
  defp hkdf(salt, ikm, info, length) do
    prk = :crypto.mac(:hmac, :sha256, salt, ikm)
    binary_part(:crypto.mac(:hmac, :sha256, prk, info <> <<1>>), 0, length)
  end

  @doc """
  Returns the `Authorization` header for a request to `endpoint`, signed with
  the application server's key pair, and naming `subject` (a `mailto:` or
  `https:` URL) as the contact.

  The token is valid for 12 hours, well under the 24 the push services allow.
  """
  def vapid_header(endpoint, {public_key, private_key}, subject) do
    %URI{scheme: scheme, host: host, port: port} = URI.parse(endpoint)
    audience = URI.to_string(%URI{scheme: scheme, host: host, port: port})
    expires = System.os_time(:second) + 12 * 60 * 60

    header = encode(Jason.encode!(%{typ: "JWT", alg: "ES256"}))
    claims = encode(Jason.encode!(%{aud: audience, exp: expires, sub: subject}))
    input = header <> "." <> claims

    der = :crypto.sign(:ecdsa, :sha256, input, [private_key, @curve])
    token = input <> "." <> encode(der_to_raw(der))

    "vapid t=#{token}, k=#{encode(public_key)}"
  end

  # JWS wants r and s side by side, 32 bytes each; :crypto gives DER.
  defp der_to_raw(der) do
    {:"ECDSA-Sig-Value", r, s} = :public_key.der_decode(:"ECDSA-Sig-Value", der)
    <<r::unsigned-256, s::unsigned-256>>
  end

  def encode(binary), do: Base.url_encode64(binary, padding: false)

  def decode(string), do: Base.url_decode64(string, padding: false)
end
