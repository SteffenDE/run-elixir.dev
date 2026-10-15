defmodule Playground.Sandbox.Builder.Log do
  @moduledoc false

  # Logs every line collected into it, for System.cmd/3 with the :lines option.

  defstruct []

  defimpl Collectable do
    require Logger

    def into(log) do
      collector = fn
        log, {:cont, ""} ->
          log

        log, {:cont, line} ->
          Logger.debug(line)
          log

        log, :done ->
          log

        _log, :halt ->
          :ok
      end

      {log, collector}
    end
  end
end
