// A project's id: ten random letters and digits, its path (/ID/), its
// origins' names (site.ts), and the name its stores are kept under. On its
// own, for the code that runs a project away from the projects' list (the
// worker of exec/host.ts).
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID = /^[a-z0-9]{10}$/;

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function isId(text: string): boolean {
  return ID.test(text);
}
