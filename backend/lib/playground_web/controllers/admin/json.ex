defmodule PlaygroundWeb.Admin.JSON do
  @moduledoc false

  # What the admin API shows of builds, templates and setups.

  def build(build, opts \\ []) do
    map = %{
      id: build.id,
      package: build.package,
      version: build.version,
      toolchain: build.toolchain,
      status: build.status,
      template_id: build.template_id,
      app: build.app,
      sha256: build.sha256,
      size: build.size,
      error: build.error,
      duration_ms: build.duration_ms,
      inserted_at: build.inserted_at,
      updated_at: build.updated_at
    }

    if opts[:log], do: Map.put(map, :log, build.log), else: map
  end

  def template(template) do
    Map.take(template, [
      :id,
      :package,
      :requirement,
      :recipe,
      :origin,
      :notes,
      :proven_version,
      :inserted_at,
      :updated_at
    ])
  end

  def setup(setup, opts \\ []) do
    map =
      Map.take(setup, [
        :id,
        :package,
        :version,
        :build_id,
        :status,
        :template_id,
        :model,
        :tool_calls,
        :input_tokens,
        :output_tokens,
        :cost_usd,
        :summary,
        :error,
        :inserted_at,
        :updated_at
      ])

    if opts[:messages], do: Map.put(map, :messages, setup.messages), else: map
  end

  def errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Enum.reduce(opts, message, fn {key, value}, message ->
        String.replace(message, "%{#{key}}", to_string(value))
      end)
    end)
  end
end
