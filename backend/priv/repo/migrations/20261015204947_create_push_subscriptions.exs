defmodule Playground.Repo.Migrations.CreatePushSubscriptions do
  use Ecto.Migration

  def change do
    create table(:push_subscriptions) do
      add :endpoint, :text, null: false
      add :p256dh, :text, null: false
      add :auth, :text, null: false
      add :device, :text
      timestamps(type: :utc_datetime)
    end

    create unique_index(:push_subscriptions, [:endpoint])
  end
end
