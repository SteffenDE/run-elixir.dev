defmodule PlaygroundWeb.Router do
  use PlaygroundWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", PlaygroundWeb do
    pipe_through :api
  end
end
