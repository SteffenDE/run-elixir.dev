defmodule PlaygroundWeb.AdminControllerTest do
  use PlaygroundWeb.ConnCase, async: true
  use Oban.Testing, repo: Playground.Repo

  alias Playground.Nif.{Build, BuildWorker}
  alias Playground.Repo

  setup %{conn: conn} do
    conn =
      conn
      |> init_test_session(github_login: "SteffenDE")
      |> put_req_header("content-type", "application/json")

    %{conn: conn}
  end

  test "writes, changes and deletes templates", %{conn: conn} do
    body = Jason.encode!(%{package: "demo", recipe: %{script: "make"}, notes: "Plain."})

    assert %{"template" => %{"id" => id, "origin" => "admin"}} =
             conn |> post(~p"/api/admin/templates", body) |> json_response(201)

    body = Jason.encode!(%{requirement: "~> 1.0", recipe: %{script: "make all"}})

    assert %{"template" => %{"requirement" => "~> 1.0", "recipe" => %{"script" => "make all"}}} =
             conn |> put(~p"/api/admin/templates/#{id}", body) |> json_response(200)

    body = Jason.encode!(%{recipe: %{script: "make", allowed_hosts: ["example.com"]}})

    assert %{"errors" => %{"recipe" => ["hosts not permitted: example.com"]}} =
             conn |> put(~p"/api/admin/templates/#{id}", body) |> json_response(422)

    assert conn |> delete(~p"/api/admin/templates/#{id}") |> response(204)

    assert %{"templates" => []} =
             conn |> get(~p"/api/admin/templates?package=demo") |> json_response(200)
  end

  test "shows builds with their logs, and queues one again", %{conn: conn} do
    build =
      Repo.insert!(%Build{
        package: "demo",
        version: "1.0.0",
        toolchain: "test",
        status: "failed",
        log: "error"
      })

    assert %{"builds" => [%{"id" => id, "status" => "failed"} = listed]} =
             conn |> get(~p"/api/admin/builds") |> json_response(200)

    refute Map.has_key?(listed, "log")

    assert %{"build" => %{"log" => "error"}} =
             conn |> get(~p"/api/admin/builds/#{id}") |> json_response(200)

    assert %{"build" => %{"status" => "queued"}} =
             conn |> post(~p"/api/admin/builds/#{id}/retry", "{}") |> json_response(200)

    assert_enqueued(worker: BuildWorker, args: %{"build_id" => build.id, "admin" => true})
  end
end
