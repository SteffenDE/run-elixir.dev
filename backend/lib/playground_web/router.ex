defmodule PlaygroundWeb.Router do
  use PlaygroundWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  # The playground's pages fetch these from their own origin, through the
  # proxy (*.run-elixir.dev/api/v1/nif), or from another one when developing.
  pipeline :public do
    plug :put_public_headers
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
    conn
    |> put_resp_header("access-control-allow-origin", "*")
    |> put_resp_header("cross-origin-resource-policy", "cross-origin")
  end
end
