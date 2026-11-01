// A project's kind: a stored project's (its template's kind, or none),
// and a page's (a temporary IEx, an empty project that is not stored and
// whose first shell runs IEx). What each looks like is the IDE's
// (app/src/shared/lib/kinds.ts); what the runtime takes from a template
// is its package's (`template.boot`, `template.port`).
export type Kind = 'phoenix' | 'empty';
export type WorkspaceKind = Kind | 'iex';
