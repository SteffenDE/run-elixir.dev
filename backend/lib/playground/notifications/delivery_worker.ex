defmodule Playground.Notifications.DeliveryWorker do
  @moduledoc """
  Sends one notification to one recipient of one backend.
  """

  # A notification about a build is worth sending late, but not days late.
  use Oban.Worker, queue: :notifications, max_attempts: 10

  alias Playground.{Notification, Notifications}

  @impl Oban.Worker
  def perform(%Oban.Job{args: args}) do
    %{"backend" => name, "recipient" => recipient, "notification" => notification} = args

    case Enum.find(Notifications.backends(), &(inspect(&1) == name)) do
      nil -> {:cancel, {:unknown_backend, name}}
      backend -> backend.deliver(recipient, Notification.load(notification))
    end
  end

  # At most ~20 minutes apart, rather than Oban's hours.
  @impl Oban.Worker
  def backoff(%Oban.Job{attempt: attempt}), do: min(Integer.pow(2, attempt) * 5, 1200)
end
