defmodule Playground.Nif.Build do
  @moduledoc """
  A package version's NIF library, built with one toolchain.

  `status`:

    * `"queued"` and `"running"` - `Playground.Nif.BuildWorker` has it
    * `"succeeded"` - the library is at `Playground.Nif.artifact_path/1`
    * `"failed"` - its template failed, `log` and `error` say how
    * `"setting_up"` - no template builds it yet, `Playground.Nif.Agent` is
      writing one
    * `"unsupported"` - nothing to build (no native code), or the agent
      gave up

  `app` is the OTP application whose `priv` the library goes into.
  """

  use Ecto.Schema

  schema "nif_builds" do
    field :package, :string
    field :version, :string
    field :toolchain, :string
    field :status, :string
    field :app, :string
    field :sha256, :string
    field :size, :integer
    field :log, :string
    field :error, :string
    field :duration_ms, :integer
    belongs_to :template, Playground.Nif.Template
    timestamps(type: :utc_datetime)
  end

  @statuses ~w(queued running succeeded failed setting_up unsupported)

  def statuses, do: @statuses
end
