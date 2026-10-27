defmodule PlaygroundWeb.NifControllerTest do
  use PlaygroundWeb.ConnCase, async: true

  alias Playground.{Nif, Repo}
  alias Playground.Nif.Build

  test "serves a built library and says where it is", %{conn: conn} do
    build = build!("1.0.0", "succeeded", sha256: "abc", size: 3, app: "demo")
    File.mkdir_p!(Path.dirname(Nif.artifact_path(build)))
    File.write!(Nif.artifact_path(build), "tar")

    conn = get(conn, ~p"/api/v1/nif/demo/1.0.0?abi=1-2.18")
    assert get_resp_header(conn, "access-control-allow-origin") == ["*"]

    assert %{"status" => "succeeded", "app" => "demo", "sha256" => "abc", "url" => url} =
             json_response(conn, 200)

    assert url == "/api/v1/nif/demo/1.0.0/library.tar"

    conn = get(build_conn(), ~p"/api/v1/nif/demo/1.0.0/library.tar")
    assert response(conn, 200) == "tar"
    assert get_resp_header(conn, "content-type") == ["application/x-tar"]
  end

  test "says to ask again while a build is pending, and why one failed", %{conn: conn} do
    build!("1.0.0", "setting_up")
    build!("2.0.0", "failed", error: "it broke")

    assert %{"status" => "setting_up"} =
             conn |> get(~p"/api/v1/nif/demo/1.0.0?abi=1-2.18") |> json_response(202)

    assert %{"status" => "failed", "error" => "it broke"} =
             build_conn() |> get(~p"/api/v1/nif/demo/2.0.0?abi=1-2.18") |> json_response(422)

    assert build_conn() |> get(~p"/api/v1/nif/demo/1.0.0/library.tar") |> json_response(404)
  end

  test "refuses a request for another NIF ABI, or for none", %{conn: conn} do
    build!("1.0.0", "succeeded", sha256: "abc", size: 3, app: "demo")

    assert %{"error" => error} =
             conn |> get(~p"/api/v1/nif/demo/1.0.0?abi=2-2.18") |> json_response(409)

    assert error =~ "NIF ABI 1-2.18, not the page's 2-2.18"

    assert %{"error" => "name the NIF ABI the page loads (?abi=)"} =
             build_conn() |> get(~p"/api/v1/nif/demo/1.0.0") |> json_response(400)
  end

  defp build!(version, status, attrs \\ []) do
    Repo.insert!(
      struct!(%Build{package: "demo", version: version, toolchain: "test", status: status}, attrs)
    )
  end
end
