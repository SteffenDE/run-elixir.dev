defmodule Playground.Sandbox.OutputTest do
  use ExUnit.Case, async: true

  alias Playground.Sandbox.Output

  @marker "SANDBOX_EOF_0123456789"

  test "collects everything before the marker" do
    output = collect(["hello ", "world", @marker, "ignored"])

    assert output.complete?
    assert Output.to_binary(output) == "hello world"
  end

  test "finds a marker split across chunks" do
    {head, tail} = String.split_at(@marker, 7)
    output = collect(["hello", head, tail, "ignored"])

    assert output.complete?
    assert Output.to_binary(output) == "hello"
  end

  test "keeps everything without a marker" do
    output = collect(["hello", String.slice(@marker, 0, 7)])

    refute output.complete?
    assert Output.to_binary(output) == "hello" <> String.slice(@marker, 0, 7)
  end

  test "keeps at most its limit, and says it cut the rest" do
    output =
      Enum.reduce(["hello", "world" <> @marker], Output.new(@marker, 7), &Output.append(&2, &1))

    assert output.complete?
    assert output.truncated?
    assert Output.to_binary(output) == "hellowo"
  end

  defp collect(chunks), do: Enum.reduce(chunks, Output.new(@marker), &Output.append(&2, &1))
end
