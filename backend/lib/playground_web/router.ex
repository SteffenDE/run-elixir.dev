defmodule PlaygroundWeb.Router do
  use PlaygroundWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  # The apex's worker fetches these (docs/frames.md): on run-elixir.dev
  # through its proxy, from the apex's own origin; from an embedder's page
  # on its allowlist (PlaygroundWeb.ServiceOrigins) with CORS. Another
  # page's request is refused (403) before any work.
  pipeline :public do
    plug :put_public_headers
    plug :require_allowed
    plug :put_cors
  end

  pipeline :session do
    plug :fetch_session
  end

  pipeline :admin do
    plug PlaygroundWeb.AdminAuth
  end

  scope "/auth", PlaygroundWeb do
    pipe_through [:session]

    get "/github", AuthController, :request
    get "/github/callback", AuthController, :callback
    delete "/logout", AuthController, :delete
  end

  scope "/api/v1/nif", PlaygroundWeb do
    pipe_through [:public]

    get "/:package/:version", NifController, :show
    get "/:package/:version/library.tar", NifController, :library
  end

  # Whether a request's page may use the services: 204, or 403. Caddy asks
  # (forward_auth) before its own git proxy, so one list decides for
  # every service (docs/deploy.md).
  scope "/api/v1", PlaygroundWeb do
    pipe_through [:public]

    get "/origin", ServiceOriginController, :show
  end

  scope "/api/admin", PlaygroundWeb.Admin do
    pipe_through [:api, :session, :admin]

    get "/builds", BuildController, :index
    post "/builds", BuildController, :create
    get "/builds/:id", BuildController, :show
    post "/builds/:id/retry", BuildController, :retry

    get "/templates", TemplateController, :index
    post "/templates", TemplateController, :create
    get "/templates/:id", TemplateController, :show
    put "/templates/:id", TemplateController, :update
    delete "/templates/:id", TemplateController, :delete

    get "/setups", SetupController, :index
    get "/setups/:id", SetupController, :show

    get "/push", PushController, :show
    post "/push/subscriptions", PushController, :subscribe
    delete "/push/subscriptions", PushController, :unsubscribe
    post "/push/test", PushController, :test
  end

  # The page that turns notifications on for a browser.
  scope "/admin", PlaygroundWeb.Admin do
    pipe_through [:session, :admin]

    get "/", PageController, :index
    get "/sw.js", PageController, :service_worker
    get "/manifest.webmanifest", PageController, :manifest
  end

  defp put_public_headers(conn, _opts) do
    put_resp_header(conn, "cross-origin-resource-policy", "cross-origin")
  end

  defp require_allowed(conn, opts), do: PlaygroundWeb.ServiceOrigins.require_allowed(conn, opts)
  defp put_cors(conn, opts), do: PlaygroundWeb.ServiceOrigins.put_cors(conn, opts)
end
