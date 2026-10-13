// Elixir and HEEx grammars for the editor (registered in languages/index.ts).
//
// Sources (pinned):
// - elixir.json: https://github.com/expert-lsp/vscode-expert/blob/v0.6.0/syntaxes/elixir.json
//   (Apache-2.0)
// - heex.json, elixir-heex.json:
//   https://github.com/phoenixframework/vscode-phoenix/blob/v0.1.3/syntaxes/ (MIT)
//
// The JSON is imported as a string: parsing JSON at run time is faster
// than parsing an object literal. Elixir and HEEx include each other, so
// both languages load all three; the ~H sigil is an injection grammar,
// whose target VS Code takes from the extension's package.json, so it is
// set here.
import elixirJson from './elixir.json?raw';
import elixirHeexJson from './elixir-heex.json?raw';
import heexJson from './heex.json?raw';

export default [
  Object.freeze({ ...JSON.parse(elixirJson), name: 'elixir' }),
  Object.freeze(JSON.parse(heexJson)),
  Object.freeze({ ...JSON.parse(elixirHeexJson), injectTo: ['source.elixir'] }),
];
