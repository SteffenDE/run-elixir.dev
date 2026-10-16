defmodule Playground.Live.Ids do
  @moduledoc "Random ids and tokens for live sessions, base64url."

  @doc "A participant's id: 64 bits, 11 characters."
  def participant, do: random(8)

  @doc "A host's token: 256 bits."
  def token, do: random(32)

  defp random(bytes), do: Base.url_encode64(:crypto.strong_rand_bytes(bytes), padding: false)
end
