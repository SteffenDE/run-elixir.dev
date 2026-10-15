defmodule Playground.Sandbox.Output do
  @moduledoc false

  # Collects what a job writes to one output channel, up to the end-of-stream
  # marker. The marker and anything after it are not part of the output. At
  # most `limit` bytes are kept, so that a job can't fill the host's memory:
  # the rest is read and dropped, and `truncated?` says so.

  defstruct [:marker, :limit, data: [], size: 0, pending: "", complete?: false, truncated?: false]

  def new(marker, limit \\ :infinity), do: %__MODULE__{marker: marker, limit: limit}

  def append(%__MODULE__{complete?: true} = output, _data), do: output

  def append(output, data) do
    buffer = output.pending <> data

    case :binary.match(buffer, output.marker) do
      {position, _length} ->
        output = keep(output, binary_part(buffer, 0, position))
        %{output | pending: "", complete?: true}

      :nomatch ->
        # The marker may start in the last bytes, so those are held back.
        pending_size = min(byte_size(buffer), byte_size(output.marker) - 1)
        size = byte_size(buffer) - pending_size

        output = keep(output, binary_part(buffer, 0, size))
        %{output | pending: binary_part(buffer, size, pending_size)}
    end
  end

  defp keep(%{limit: :infinity} = output, data),
    do: %{output | data: [output.data | data], size: output.size + byte_size(data)}

  defp keep(output, data) do
    room = max(output.limit - output.size, 0)

    if byte_size(data) <= room do
      %{output | data: [output.data | data], size: output.size + byte_size(data)}
    else
      %{
        output
        | data: [output.data | binary_part(data, 0, room)],
          size: output.limit,
          truncated?: true
      }
    end
  end

  # The pending bytes are output too when the marker never came.
  def to_binary(%{complete?: true} = output), do: IO.iodata_to_binary(output.data)
  def to_binary(output), do: IO.iodata_to_binary(keep(output, output.pending).data)
end
