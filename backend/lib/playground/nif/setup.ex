defmodule Playground.Nif.Setup do
  @moduledoc """
  A session of `Playground.Nif.Agent` writing a template for a package,
  starting from one version's failed or missing build.

  `messages` is the conversation, as stored by `Playground.Nif.Agent`;
  `status` is `"running"`, `"succeeded"` (with `template_id`) or `"failed"`
  (with `error`).
  """

  use Ecto.Schema

  schema "nif_setups" do
    field :package, :string
    field :version, :string
    field :status, :string
    field :model, :string
    field :messages, {:array, :map}, default: []
    field :tool_calls, :integer, default: 0
    field :input_tokens, :integer, default: 0
    field :output_tokens, :integer, default: 0
    field :cost_usd, :float, default: 0.0
    field :summary, :string
    field :error, :string
    belongs_to :build, Playground.Nif.Build
    belongs_to :template, Playground.Nif.Template
    timestamps(type: :utc_datetime)
  end
end
