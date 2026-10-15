defmodule Playground.Notifications do
  @moduledoc """
  Tells whoever runs the backend about things, through every configured backend.

      config :playground, Playground.Notifications, backends: [Playground.Notifications.WebPush]

  See `Playground.Notifications.Backend` for writing one.
  """

  alias Playground.Notification
  alias Playground.Notifications.DeliveryWorker

  @doc """
  Queues `notification` for every recipient of every backend.

  The jobs are inserted with the caller's transaction, if any, so a
  notification about a row is sent exactly when the row is committed.
  """
  def notify(%Notification{} = notification) do
    for backend <- backends(), reduce: [] do
      jobs -> jobs ++ notify(notification, backend, backend.recipients())
    end
  end

  @doc """
  Queues `notification` for the given recipients of one backend only, such as
  a test message to one person's devices.
  """
  def notify(%Notification{} = notification, backend, recipients) do
    args = Notification.dump(notification)

    recipients
    |> Enum.map(fn recipient ->
      DeliveryWorker.new(%{
        "backend" => inspect(backend),
        "recipient" => recipient,
        "notification" => args
      })
    end)
    |> Oban.insert_all()
  end

  @doc """
  The configured backends.
  """
  def backends do
    :playground |> Application.get_env(__MODULE__, []) |> Keyword.get(:backends, [])
  end
end
