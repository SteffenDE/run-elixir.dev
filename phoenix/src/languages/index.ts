import { registerCustomLanguage } from '@pierre/diffs';

// Shiki has no HEEx; these grammars cover Elixir, HEEx and ~H.
registerCustomLanguage('elixir', () => import('./elixir'), ['ex', 'exs']);
registerCustomLanguage('heex', () => import('./elixir'), ['heex']);
