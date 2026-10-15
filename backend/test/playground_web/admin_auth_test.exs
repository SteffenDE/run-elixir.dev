defmodule PlaygroundWeb.AdminAuthTest do
  use PlaygroundWeb.ConnCase, async: true

  test "sends visitors of the page to sign in", %{conn: conn} do
    assert conn |> get(~p"/admin") |> redirected_to() == ~p"/auth/github"
  end

  test "answers the API 401 without an admin", %{conn: conn} do
    assert conn |> get(~p"/api/admin/push") |> json_response(401)

    conn = conn |> init_test_session(github_login: "someone") |> get(~p"/api/admin/push")
    assert json_response(conn, 401)
  end

  test "lets in an admin", %{conn: conn} do
    conn = conn |> init_test_session(github_login: "SteffenDE") |> get(~p"/api/admin/push")
    assert %{"public_key" => _, "subscriptions" => []} = json_response(conn, 200)
  end

  test "takes changes only as JSON", %{conn: conn} do
    conn =
      conn
      |> init_test_session(github_login: "SteffenDE")
      |> put_req_header("content-type", "application/x-www-form-urlencoded")
      |> post(~p"/api/admin/push/test", "a=b")

    assert json_response(conn, 415)
  end
end
