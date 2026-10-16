defmodule PlaygroundWeb.LiveSocket do
  @moduledoc """
  The playground's socket, `/socket`: live sessions' relay. Anyone may
  connect; a session's link is what keeps it private (its id, and the key
  the relay never sees).
  """

  use Phoenix.Socket

  channel "live:*", PlaygroundWeb.LiveChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  @impl true
  def id(_socket), do: nil
end
