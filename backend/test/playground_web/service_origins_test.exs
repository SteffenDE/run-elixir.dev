defmodule PlaygroundWeb.ServiceOriginsTest do
  # Sets the application's :service_origins: not async.
  use PlaygroundWeb.ConnCase, async: false

  alias Phoenix.Socket.Transport
  alias Playground.Repo
  alias Playground.Nif.Build
  alias PlaygroundWeb.RelaySocket

  setup do
    Application.put_env(:playground, :service_origins, [
      "https://run-elixir.dev",
      "https://tidewave.ai"
    ])

    on_exit(fn -> Application.delete_env(:playground, :service_origins) end)
  end

  # A request to the NIF builds, with these headers.
  defp nif(path, headers) do
    Enum.reduce(headers, build_conn(), fn {name, value}, conn ->
      put_req_header(conn, name, value)
    end)
    |> get(path)
  end

  test "a NIF build answers an allowed origin, with CORS" do
    Repo.insert!(%Build{
      package: "demo",
      version: "1.0.0",
      toolchain: "test",
      status: "succeeded",
      sha256: "abc",
      size: 3,
      app: "demo"
    })

    conn = nif("/api/v1/nif/demo/1.0.0?abi=1-2.18", [{"origin", "https://tidewave.ai"}])
    assert %{"status" => "succeeded"} = json_response(conn, 200)
    assert get_resp_header(conn, "access-control-allow-origin") == ["https://tidewave.ai"]
  end

  test "another origin's request is refused before a build is queued" do
    # A version no build exists for: an allowed request would ask Hex and
    # queue one.
    for headers <- [
          [{"origin", "https://evil.example"}],
          [{"origin", "null"}],
          [{"origin", "https://evil.example"}, {"sec-fetch-site", "same-origin"}],
          # Another site's <img> or <script>: no Origin, but marked.
          [{"sec-fetch-site", "cross-site"}]
        ] do
      conn = nif("/api/v1/nif/jason/1.4.4?abi=1-2.18", headers)
      assert response(conn, 403) =~ "may not use these services", inspect(headers)
      assert get_resp_header(conn, "access-control-allow-origin") == []
    end

    assert Repo.aggregate(Build, :count) == 0
  end

  test "a request without an Origin goes on (a non-browser client, the apex's own GET)" do
    for headers <- [[], [{"sec-fetch-site", "same-origin"}], [{"sec-fetch-site", "none"}]] do
      # 400: past the origin check, at the controller's (no abi).
      conn = nif("/api/v1/nif/jason/1.4.4", headers)
      assert json_response(conn, 400), inspect(headers)
    end
  end

  test "any origin while the list is unset (developing)" do
    Application.delete_env(:playground, :service_origins)
    conn = nif("/api/v1/nif/jason/1.4.4", [{"origin", "http://localhost:4000"}])
    assert json_response(conn, 400)
  end

  test "/api/v1/origin answers whether the page may use the services (Caddy's forward_auth)" do
    assert response(nif("/api/v1/origin", [{"origin", "https://tidewave.ai"}]), 204)
    assert response(nif("/api/v1/origin", []), 204)
    assert response(nif("/api/v1/origin", [{"origin", "https://evil.example"}]), 403)
    assert response(nif("/api/v1/origin", [{"sec-fetch-site", "cross-site"}]), 403)
  end

  # The relay socket's upgrade, through the endpoint's origin check.
  defp relay(origin) do
    conn = build_conn(:get, "/relay")
    conn = if origin, do: put_req_header(conn, "origin", origin), else: conn

    Transport.check_origin(conn, RelaySocket, PlaygroundWeb.Endpoint,
      check_origin: {RelaySocket, :origin_allowed?, []}
    )
  end

  test "the relay socket opens for an allowed origin, and without one" do
    refute relay("https://tidewave.ai").halted
    refute relay("https://run-elixir.dev").halted
    # A non-browser client: no Origin to check.
    refute relay(nil).halted
  end

  test "the relay socket refuses another origin" do
    ExUnit.CaptureLog.capture_log(fn ->
      conn = relay("https://evil.example")
      assert conn.halted
      assert conn.status == 403
    end)
  end
end
