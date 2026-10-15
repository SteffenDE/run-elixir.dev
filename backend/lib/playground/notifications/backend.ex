defmodule Playground.Notifications.Backend do
  @moduledoc """
  A way of telling whoever runs the backend about a `Playground.Notification`.

  A backend has recipients, each of which is sent every notification in a job
  of its own, so that one that fails is retried without repeating the others.
  What a recipient is, is up to the backend: a push subscription, a Slack
  channel, an address.
  """

  @doc """
  Returns the recipients to send a notification to, as values that survive a
  round trip through JSON.
  """
  @callback recipients() :: [term()]

  @doc """
  Sends a notification to one recipient.

  `{:error, reason}` is retried, `{:cancel, reason}` is not: return it when
  sending again cannot succeed. A recipient that is gone for good is not an
  error; forget it and return `:ok`.
  """
  @callback deliver(recipient :: term(), Playground.Notification.t()) ::
              :ok | {:error, term()} | {:cancel, term()}
end
