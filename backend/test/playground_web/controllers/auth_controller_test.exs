defmodule PlaygroundWeb.AuthControllerTest do
  use PlaygroundWeb.ConnCase, async: true

  setup {Req.Test, :verify_on_exit!}

  test "GET /auth/github", %{conn: conn} do
    conn = get(conn, ~p"/auth/github")
    "https://github.com/login/oauth/authorize?" <> query = redirected_to(conn)
    assert URI.decode_query(query)["state"] == get_session(conn, :github_state)
  end

  describe "GET /auth/github/callback" do
    test "signs in an admin", %{conn: conn} do
      expect("POST", "https://github.com/login/oauth/access_token", fn conn ->
        assert conn.body_params["code"] == "code"
        Req.Test.json(conn, %{"access_token" => "token"})
      end)

      expect("GET", "https://api.github.com/user", fn conn ->
        assert get_req_header(conn, "authorization") == ["Bearer token"]
        Req.Test.json(conn, %{"login" => "SteffenDE"})
      end)

      conn =
        conn
        |> init_test_session(github_state: "abc")
        |> get(~p"/auth/github/callback", code: "code", state: "abc")

      assert redirected_to(conn) == ~p"/admin"
      assert get_session(conn, :github_login) == "SteffenDE"
      refute get_session(conn, :github_state)
    end

    test "rejects others", %{conn: conn} do
      expect("POST", "https://github.com/login/oauth/access_token", fn conn ->
        Req.Test.json(conn, %{"access_token" => "token"})
      end)

      expect("GET", "https://api.github.com/user", fn conn ->
        Req.Test.json(conn, %{"login" => "someone"})
      end)

      conn =
        conn
        |> init_test_session(github_state: "abc")
        |> get(~p"/auth/github/callback", code: "code", state: "abc")

      assert text_response(conn, 400)
      refute get_session(conn, :github_login)
    end

    test "rejects a bad state", %{conn: conn} do
      conn =
        conn
        |> init_test_session(github_state: "abc")
        |> get(~p"/auth/github/callback", code: "code", state: "xyz")

      assert text_response(conn, 400)
      refute get_session(conn, :github_login)
    end

    test "rejects a failed token exchange", %{conn: conn} do
      expect("POST", "https://github.com/login/oauth/access_token", fn conn ->
        Req.Test.json(conn, %{
          "error" => "bad_verification_code",
          "error_description" => "The code passed is incorrect or expired."
        })
      end)

      conn =
        conn
        |> init_test_session(github_state: "abc")
        |> get(~p"/auth/github/callback", code: "code", state: "abc")

      assert text_response(conn, 400)
      refute get_session(conn, :github_login)
    end

    test "rejects a failed user lookup", %{conn: conn} do
      expect("POST", "https://github.com/login/oauth/access_token", fn conn ->
        Req.Test.json(conn, %{"access_token" => "token"})
      end)

      expect("GET", "https://api.github.com/user", fn conn ->
        conn |> put_status(401) |> Req.Test.json(%{"message" => "Bad credentials"})
      end)

      conn =
        conn
        |> init_test_session(github_state: "abc")
        |> get(~p"/auth/github/callback", code: "code", state: "abc")

      assert text_response(conn, 400)
      refute get_session(conn, :github_login)
    end
  end

  test "DELETE /auth/logout", %{conn: conn} do
    conn = conn |> init_test_session(github_login: "SteffenDE") |> delete(~p"/auth/logout")
    assert redirected_to(conn) == ~p"/auth/github"
    assert conn |> get(~p"/admin") |> redirected_to() == ~p"/auth/github"
  end

  defp expect(method, url, fun) do
    url = URI.new!(url)

    Req.Test.expect(Playground.GitHubOAuth, fn conn ->
      assert conn.method == method
      assert conn.host == url.host
      assert conn.request_path == url.path
      fun.(conn)
    end)
  end
end
