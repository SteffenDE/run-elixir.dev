defmodule Playground.Notifications.WebPush do
  @moduledoc """
  Notifies browsers through their push service, which on an iPhone means a
  web app added to the home screen.

  The application server is identified by a P-256 key pair, of which only the
  private key is configured, base64url encoded; `mix playground.gen.vapid` makes one.
  Browsers subscribe with the public key, so replacing the key orphans every
  subscription.

      config :playground, Playground.Notifications.WebPush,
        private_key: "...",
        subject: "mailto:someone@example.com"

  Without a key the backend has no recipients and nobody can subscribe.
  """

  @behaviour Playground.Notifications.Backend

  import Ecto.Query

  alias Playground.{Notification, Repo}
  alias Playground.Notifications.WebPush.{Crypto, Subscription}

  # How long a push service holds a message for a device that is offline.
  @ttl 24 * 60 * 60

  @doc """
  Returns whether a key pair is configured.
  """
  def configured?, do: config()[:private_key] != nil

  @doc """
  Returns the public key browsers subscribe with, base64url encoded.
  """
  def public_key do
    {public_key, _private_key} = keys()
    Crypto.encode(public_key)
  end

  defp keys do
    {:ok, private_key} = Crypto.decode(Keyword.fetch!(config(), :private_key))
    {Crypto.public_key(private_key), private_key}
  end

  defp config, do: Application.get_env(:playground, __MODULE__, [])

  @doc """
  Returns the subscriptions, newest first.
  """
  def list_subscriptions do
    Repo.all(from s in Subscription, order_by: [desc: s.inserted_at, desc: s.id])
  end

  @doc """
  Saves the subscription of a browser, as its `PushSubscription.toJSON()`
  gives it, plus a `"device"` name.

  A browser that subscribes again keeps its endpoint and may have new keys, so
  the endpoint's subscription is replaced.
  """
  def subscribe(params) do
    attrs = %{
      endpoint: params["endpoint"],
      p256dh: get_in(params, ["keys", "p256dh"]),
      auth: get_in(params, ["keys", "auth"]),
      device: params["device"]
    }

    %Subscription{}
    |> Subscription.changeset(attrs)
    |> Repo.insert(
      on_conflict: {:replace, [:p256dh, :auth, :device, :updated_at]},
      conflict_target: :endpoint,
      returning: true
    )
  end

  @doc """
  Deletes a subscription, by id or by endpoint.
  """
  def unsubscribe(by) do
    query =
      case by do
        {:id, id} -> from s in Subscription, where: s.id == ^id
        {:endpoint, endpoint} -> from s in Subscription, where: s.endpoint == ^endpoint
      end

    {count, _} = Repo.delete_all(query)
    count
  end

  @impl true
  def recipients do
    if configured?(), do: Repo.all(from s in Subscription, select: s.id), else: []
  end

  @impl true
  def deliver(id, %Notification{} = notification) do
    case Repo.get(Subscription, id) do
      nil -> :ok
      subscription -> push(subscription, notification)
    end
  end

  defp push(subscription, notification) do
    {:ok, p256dh} = Crypto.decode(subscription.p256dh)
    {:ok, auth} = Crypto.decode(subscription.auth)
    body = Crypto.encrypt(payload(notification), p256dh, auth)

    headers =
      [
        authorization: Crypto.vapid_header(subscription.endpoint, keys(), config()[:subject]),
        content_encoding: "aes128gcm",
        content_type: "application/octet-stream",
        ttl: Integer.to_string(@ttl),
        urgency: urgency(notification.level)
      ] ++ topic(notification.tag)

    request = [
      method: :post,
      url: subscription.endpoint,
      headers: headers,
      body: body,
      retry: false,
      decode_body: false
    ]

    case Req.request(request ++ req_options()) do
      {:ok, %{status: status}} when status in 200..299 ->
        :ok

      # The browser unsubscribed, or the subscription expired.
      {:ok, %{status: status}} when status in [404, 410] ->
        Repo.delete_all(from s in Subscription, where: s.id == ^subscription.id)
        :ok

      {:ok, %{status: status} = response} when status == 429 or status >= 500 ->
        {:error, {:push_service, status, response.body}}

      {:ok, %{status: status} = response} ->
        {:cancel, {:push_service, status, response.body}}

      {:error, exception} ->
        {:error, exception}
    end
  end

  # What the service worker shows, see priv/static/admin/sw.js. A payload is capped
  # at a few KB, and a notification shows a few lines anyway.
  defp payload(notification) do
    Jason.encode!(%{
      title: truncate(notification.title, 100),
      body: truncate(notification.body, 500),
      url: notification.url,
      tag: notification.tag
    })
  end

  defp truncate(text, length) do
    if String.length(text) > length, do: String.slice(text, 0, length - 1) <> "…", else: text
  end

  defp urgency(:info), do: "normal"
  defp urgency(_warning_or_critical), do: "high"

  # A newer message with the same topic replaces one the push service still
  # holds. A topic is at most 32 characters of base64url.
  defp topic(nil), do: []
  defp topic(tag), do: [topic: Crypto.encode(binary_part(:crypto.hash(:sha256, tag), 0, 24))]

  if Mix.env() == :test do
    defp req_options, do: [plug: {Req.Test, __MODULE__}]
  else
    defp req_options, do: []
  end
end
