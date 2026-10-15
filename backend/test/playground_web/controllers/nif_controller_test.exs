defmodule PlaygroundWeb.NifControllerTest do
  use PlaygroundWeb.ConnCase, async: true

  alias Playground.{Nif, Repo}
  alias Playground.Nif.Build

  test "serves a built library and says where it is", %{conn: conn} do
    build = build!("1.0.0", "succeeded", sha256: "abc", size: 3, app: "demo")
    File.mkdir_p!(Path.dirname(Nif.artifact_path(build)))
    File.write!(Nif.artifact_path(build), "tar")

    conn = get(conn, ~p"/api/nif/demo/1.0.0")
    assert get_resp_header(conn, "access-control-allow-origin") == ["*"]

    assert %{"status" => "succeeded", "app" => "demo", "sha256" => "abc", "url" => url} =
             json_response(conn, 200)

    assert url == "/api/nif/demo/1.0.0/library.tar"

    conn = get(build_conn(), ~p"/api/nif/demo/1.0.0/library.tar")
    assert response(conn, 200) == "tar"
    assert get_resp_header(conn, "content-type") == ["application/x-tar"]
  end

  test "says to ask again while a build is pending, and why one failed", %{conn: conn} do
    build!("1.0.0", "setting_up")
    build!("2.0.0", "failed", error: "it broke")

    assert %{"status" => "setting_up"} =
             conn |> get(~p"/api/nif/demo/1.0.0") |> json_response(202)

    assert %{"status" => "failed", "error" => "it broke"} =
             build_conn() |> get(~p"/api/nif/demo/2.0.0") |> json_response(422)

    assert build_conn() |> get(~p"/api/nif/demo/1.0.0/library.tar") |> json_response(404)
  end

  defp build!(version, status, attrs \\ []) do
    Repo.insert!(
      struct!(%Build{package: "demo", version: version, toolchain: "test", status: status}, attrs)
    )
  end
end
