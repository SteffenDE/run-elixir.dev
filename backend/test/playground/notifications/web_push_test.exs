defmodule Playground.Notifications.WebPushTest do
  use Playground.DataCase, async: true
  use Oban.Testing, repo: Playground.Repo

  alias Playground.{Notification, Notifications}
  alias Playground.Notifications.{DeliveryWorker, WebPush}
  alias Playground.Notifications.WebPush.{Crypto, Subscription}

  setup {Req.Test, :verify_on_exit!}

  # RFC 8291, appendix A.
  test "encrypts a payload as the RFC's example does" do
    body =
      Crypto.encrypt(
        "When I grow up, I want to be a watermelon",
        decode!(
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
        ),
        decode!("BTBZMqHH6r4Tts7J_aSIgg"),
        keys:
          {decode!(
             "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
           ), decode!("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")},
        salt: decode!("DGv6ra1nlYgDCS1FRnbzlw")
      )

    assert Crypto.encode(body) ==
             "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
  end

  test "pushes an encrypted notification, signed for the push service" do
    {browser, subscription} = subscribe()

    Req.Test.expect(WebPush, fn conn ->
      assert conn.host == "push.example.com"
      assert conn.request_path == "/send/abc"
      assert Plug.Conn.get_req_header(conn, "content-encoding") == ["aes128gcm"]
      assert Plug.Conn.get_req_header(conn, "urgency") == ["high"]

      ["vapid t=" <> vapid] = Plug.Conn.get_req_header(conn, "authorization")
      [token, "k=" <> key] = String.split(vapid, ", ")
      assert key == WebPush.public_key()
      assert %{"aud" => "https://push.example.com", "sub" => "mailto:" <> _} = verify!(token, key)

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert %{"title" => "Malicious release", "url" => "https://sca.test/r/1"} =
               body |> decrypt!(browser) |> Jason.decode!()

      Plug.Conn.send_resp(conn, 201, "")
    end)

    notification = %Notification{
      title: "Malicious release",
      body: "evil 1.0.0",
      url: "https://sca.test/r/1",
      level: :critical
    }

    assert [_job] = Notifications.notify(notification)
    assert_enqueued(worker: DeliveryWorker, args: %{"recipient" => subscription.id})
    assert %{success: 1} = Oban.drain_queue(queue: :notifications)
  end

  test "forgets a subscription the push service says is gone" do
    {_browser, subscription} = subscribe()
    Req.Test.expect(WebPush, &Plug.Conn.send_resp(&1, 410, ""))

    assert :ok = WebPush.deliver(subscription.id, %Notification{title: "Hi"})
    refute Repo.get(Subscription, subscription.id)
  end

  test "retries when the push service is unavailable, but not when it refuses" do
    {_browser, subscription} = subscribe()
    Req.Test.expect(WebPush, &Plug.Conn.send_resp(&1, 503, ""))
    Req.Test.expect(WebPush, &Plug.Conn.send_resp(&1, 403, "bad jwt"))

    assert {:error, {:push_service, 503, _}} =
             WebPush.deliver(subscription.id, %Notification{title: "Hi"})

    assert {:cancel, {:push_service, 403, "bad jwt"}} =
             WebPush.deliver(subscription.id, %Notification{title: "Hi"})
  end

  test "a browser subscribing again replaces its subscription" do
    {_browser, first} = subscribe()
    {_browser, second} = subscribe()

    assert first.id == second.id
    assert [_one] = Repo.all(Subscription)
    assert WebPush.unsubscribe({:id, first.id}) == 1
    assert WebPush.unsubscribe({:id, first.id}) == 0
  end

  defp subscribe do
    {public_key, private_key} = Crypto.generate_keys()
    auth = :crypto.strong_rand_bytes(16)

    {:ok, subscription} =
      WebPush.subscribe(%{
        "endpoint" => "https://push.example.com/send/abc",
        "keys" => %{"p256dh" => Crypto.encode(public_key), "auth" => Crypto.encode(auth)},
        "device" => "iPhone"
      })

    {{public_key, private_key, auth}, subscription}
  end

  # What the browser does, RFC 8291 section 3.4.
  defp decrypt!(body, {ua_public, ua_private, auth}) do
    <<salt::binary-16, _rs::32, 65, as_public::binary-65, ciphertext::binary>> = body
    ecdh = :crypto.compute_key(:ecdh, as_public, ua_private, :prime256v1)
    ikm = hkdf(auth, ecdh, "WebPush: info\0" <> ua_public <> as_public, 32)
    cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
    nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0", 12)

    length = byte_size(ciphertext) - 16
    tag = binary_part(ciphertext, length, 16)
    ciphertext = binary_part(ciphertext, 0, length)

    plaintext =
      :crypto.crypto_one_time_aead(:aes_128_gcm, cek, nonce, ciphertext, "", tag, false)

    String.trim_trailing(plaintext, <<2>>)
  end

  defp hkdf(salt, ikm, info, length) do
    prk = :crypto.mac(:hmac, :sha256, salt, ikm)
    binary_part(:crypto.mac(:hmac, :sha256, prk, info <> <<1>>), 0, length)
  end

  defp verify!(token, key) do
    [header, claims, signature] = String.split(token, ".")
    <<r::unsigned-256, s::unsigned-256>> = decode!(signature)
    der = :public_key.der_encode(:"ECDSA-Sig-Value", {:"ECDSA-Sig-Value", r, s})

    assert :crypto.verify(:ecdsa, :sha256, header <> "." <> claims, der, [
             decode!(key),
             :prime256v1
           ])

    claims |> decode!() |> Jason.decode!()
  end

  defp decode!(string) do
    {:ok, binary} = Crypto.decode(string)
    binary
  end
end
