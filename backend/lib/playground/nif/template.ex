defmodule Playground.Nif.Template do
  @moduledoc """
  How to build a package's NIF library, for the versions `requirement` meets
  (all of them when it's `nil`). Its `recipe` is a `Playground.Nif.Recipe`.

  `origin` says who wrote it: `"seed"` (nif/build.py's recipes),
  `"agent"` (`Playground.Nif.Agent`) or `"admin"`. `proven_version` is a
  version it built.
  """

  use Ecto.Schema

  import Ecto.Changeset

  schema "nif_templates" do
    field :package, :string
    field :requirement, :string
    field :recipe, :map
    field :origin, :string
    field :notes, :string
    field :proven_version, :string
    timestamps(type: :utc_datetime)
  end

  def changeset(template, attrs) do
    template
    |> cast(attrs, [:package, :requirement, :recipe, :origin, :notes, :proven_version])
    |> validate_required([:package, :recipe, :origin])
    |> validate_inclusion(:origin, ~w(seed agent admin))
    |> validate_change(:requirement, fn :requirement, requirement ->
      case Version.parse_requirement(requirement) do
        {:ok, _} -> []
        :error -> [requirement: "is not a version requirement"]
      end
    end)
    |> validate_change(:recipe, fn :recipe, recipe ->
      case Playground.Nif.Recipe.new(recipe) do
        {:ok, _} -> []
        {:error, reason} -> [recipe: reason]
      end
    end)
  end

  @doc """
  Returns whether the template is for `version`.
  """
  def applies?(%__MODULE__{requirement: nil}, _version), do: true

  def applies?(%__MODULE__{requirement: requirement}, version),
    do: Version.match?(version, requirement, allow_pre: true)
end
