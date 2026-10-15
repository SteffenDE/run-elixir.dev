defmodule Mix.Tasks.Playground.Gen.Vapid do
  @shortdoc "Generates a key pair for Web Push"

  @moduledoc """
  Generates a key pair for `Playground.Notifications.WebPush` and prints the private
  key, for `PLAYGROUND_VAPID_PRIVATE_KEY`, and the public key it implies.

      $ mix playground.gen.vapid

  """

  use Mix.Task

  alias Playground.Notifications.WebPush.Crypto

  @impl true
  def run(_args) do
    {public_key, private_key} = Crypto.generate_keys()

    Mix.shell().info("""
    PLAYGROUND_VAPID_PRIVATE_KEY=#{Crypto.encode(private_key)}

    Public key: #{Crypto.encode(public_key)}
    """)
  end
end
