defmodule Playground.Repo.Migrations.CreateNifTables do
  use Ecto.Migration

  def change do
    create table(:nif_templates) do
      add :package, :text, null: false
      add :requirement, :text
      add :recipe, :map, null: false
      add :origin, :text, null: false
      add :notes, :text
      add :proven_version, :text
      timestamps(type: :utc_datetime)
    end

    create index(:nif_templates, [:package])

    create table(:nif_builds) do
      add :package, :text, null: false
      add :version, :text, null: false
      add :toolchain, :text, null: false
      add :status, :text, null: false
      add :template_id, references(:nif_templates, on_delete: :nilify_all)
      add :app, :text
      add :sha256, :text
      add :size, :integer
      add :log, :text
      add :error, :text
      add :duration_ms, :integer
      timestamps(type: :utc_datetime)
    end

    create unique_index(:nif_builds, [:package, :version, :toolchain])

    create table(:nif_setups) do
      add :package, :text, null: false
      add :version, :text, null: false
      add :build_id, references(:nif_builds, on_delete: :delete_all)
      add :status, :text, null: false
      add :template_id, references(:nif_templates, on_delete: :nilify_all)
      add :model, :text, null: false
      add :messages, {:array, :map}, null: false, default: []
      add :tool_calls, :integer, null: false, default: 0
      add :input_tokens, :integer, null: false, default: 0
      add :output_tokens, :integer, null: false, default: 0
      add :cost_usd, :float, null: false, default: 0.0
      add :summary, :text
      add :error, :text
      timestamps(type: :utc_datetime)
    end

    create index(:nif_setups, [:package])
    create index(:nif_setups, [:inserted_at])
  end
end
