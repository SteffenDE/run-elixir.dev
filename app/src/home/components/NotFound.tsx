// A path that is no project in this browser.
export function NotFound() {
  return (
    <div className="home">
      <main className="home-main">
        <h1 className="home-title">
          Elixir <span>Playground</span>
        </h1>
        <p>There is no such project in this browser. Projects are kept where they were made.</p>
        <p>
          <a href="/">All projects</a>
        </p>
      </main>
    </div>
  );
}
