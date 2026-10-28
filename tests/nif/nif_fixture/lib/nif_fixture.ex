defmodule NifFixture do
  @moduledoc "A NIF library in C++, for the playground's tests."
  @on_load :init

  def init, do: :erlang.load_nif(:filename.join(:code.priv_dir(:nif_fixture), ~c"nif_fixture"), 0)

  @doc "a + b, in the library."
  def add(_a, _b), do: :erlang.nif_error(:not_loaded)

  @doc "The integer a string spells, by std::stoi: what it throws raises."
  def parse(_string), do: :erlang.nif_error(:not_loaded)
end
