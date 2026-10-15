defmodule PlaygroundWeb.Admin.PushController do
  use PlaygroundWeb, :controller

  alias Playground.{Notification, Notifications}
  alias Playground.Notifications.WebPush

  def show(conn, _params) do
    subscriptions =
      for s <- WebPush.list_subscriptions(),
          do: %{id: s.id, endpoint: s.endpoint, device: s.device, inserted_at: s.inserted_at}

    json(conn, %{
      public_key: if(WebPush.configured?(), do: WebPush.public_key()),
      subscriptions: subscriptions
    })
  end

  def subscribe(conn, params) do
    case WebPush.subscribe(params) do
      {:ok, subscription} ->
        conn |> put_status(201) |> json(%{id: subscription.id})

      {:error, changeset} ->
        conn |> put_status(422) |> json(%{errors: PlaygroundWeb.Admin.JSON.errors(changeset)})
    end
  end

  def unsubscribe(conn, %{"endpoint" => endpoint}) do
    json(conn, %{deleted: WebPush.unsubscribe({:endpoint, endpoint})})
  end

  def test(conn, _params) do
    Notifications.notify(%Notification{
      title: "Playground backend",
      body: "Notifications reach this device.",
      tag: "test"
    })

    json(conn, %{sent: true})
  end
end
