# Run by test.py in the Node harness, beside layer.so.
defmodule Layer do
  @on_load :init
  def init, do: :erlang.load_nif(~c"/work/layer/layer", 0)
  def new(_), do: :erlang.nif_error(:not_loaded)
  def bump(_), do: :erlang.nif_error(:not_loaded)
  def echo(_), do: :erlang.nif_error(:not_loaded)
  def touch(_), do: :erlang.nif_error(:not_loaded)
  def advise(_), do: :erlang.nif_error(:not_loaded)
  def extras(_), do: :erlang.nif_error(:not_loaded)
end

counter = Layer.new(41)
IO.inspect({is_reference(counter), counter == counter}, label: "resource")
IO.inspect(Layer.bump(counter), label: "bump")
IO.inspect(Layer.bump(counter), label: "bump")
receive do m -> IO.inspect(m, label: "message") after 0 -> IO.puts("message: none") end
term = {self(), make_ref(), [1, 2.5, "bin", :atom, <<1::3>>, Bitwise.bsl(1, 70), -Bitwise.bsl(1, 70), %{a: [b: 1]}], &IO.puts/1}
IO.inspect(Layer.echo(term) == term, label: "echo")
IO.inspect(try(do: Layer.new(:x), rescue: (e -> e)), label: "badarg")
IO.inspect(try(do: Layer.bump(make_ref()), rescue: (e -> e)), label: "not a counter")
IO.inspect(Layer.touch(~c"/tmp/layer-touched"), label: "touch")
IO.inspect(Layer.advise(~c"/tmp/layer-touched"), label: "advise")
IO.inspect(Layer.extras(~c"/tmp/layer-extras"), label: "extras")
