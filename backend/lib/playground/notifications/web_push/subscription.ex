defmodule Playground.Notifications.WebPush.Subscription do
  @moduledoc """
  A browser that asked to be notified.

  `endpoint`, `p256dh` and `auth` are what the browser's `PushSubscription`
  serializes to. `device` is a name to tell subscriptions apart by, derived
  from the user agent.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Playground.Notifications.WebPush.Crypto

  schema "push_subscriptions" do
    field :endpoint, :string
    field :p256dh, :string
    field :auth, :string
    field :device, :string
    timestamps(type: :utc_datetime)
  end

  def changeset(subscription, attrs) do
    subscription
    |> cast(attrs, [:endpoint, :p256dh, :auth, :device])
    |> validate_required([:endpoint, :p256dh, :auth])
    |> validate_change(:endpoint, fn :endpoint, endpoint ->
      case URI.new(endpoint) do
        {:ok, %URI{scheme: "https", host: host}} when host not in [nil, ""] -> []
        _other -> [endpoint: "must be an https URL"]
      end
    end)
    |> validate_key(:p256dh, 65)
    |> validate_key(:auth, 16)
    |> validate_length(:device, max: 100)
    |> unique_constraint(:endpoint)
  end

  defp validate_key(changeset, field, size) do
    validate_change(changeset, field, fn ^field, value ->
      case Crypto.decode(value) do
        {:ok, key} when byte_size(key) == size -> []
        _other -> [{field, "must be #{size} bytes, base64url encoded"}]
      end
    end)
  end
end
