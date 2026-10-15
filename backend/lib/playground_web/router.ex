defmodule PlaygroundWeb.Router do
  use PlaygroundWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
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

  scope "/api/admin", PlaygroundWeb.Admin do
    pipe_through [:api, :session, :admin]

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
end
