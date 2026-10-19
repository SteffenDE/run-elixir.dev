import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';
import { useState, type ReactNode } from 'react';
import { TAG } from '@/tailscale/protocol';

// What the user adds to the tailnet's policy file: the tag, which its
// members may give a device, and a grant that lets the tag use exit nodes
// and reach nothing else (autogroup:internet is the internet through an
// exit node, not the tailnet's devices).
export const POLICY = `"tagOwners": {
  "${TAG}": ["autogroup:member"]
},
"grants": [
  {
    "src": ["${TAG}"],
    "dst": ["autogroup:internet"],
    "ip":  ["*"]
  }
]`;

// The same grant in the older acls syntax.
export const POLICY_ACL = `{ "action": "accept", "src": ["${TAG}"], "dst": ["autogroup:internet:*"] }`;

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <RiCheckLine size={14} /> : <RiFileCopyLine size={14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// Setting Tailscale up for the playground, once per tailnet and browser:
// the policy, an exit node, signing in.
export function SetupSteps({ signIn }: { signIn: ReactNode }) {
  return (
    <ol className="tailscale-steps">
      <li>
        <strong>Let the playground in, for exit nodes only.</strong> In the admin console's{' '}
        <a href="https://login.tailscale.com/admin/acls/file" target="_blank" rel="noreferrer">
          Access controls
        </a>
        , add these to your policy file's <code>tagOwners</code> and <code>grants</code>:
        <div className="tailscale-policy">
          <pre>{POLICY}</pre>
          <CopyButton text={POLICY} />
        </div>
        The playground signs in as <code>{TAG}</code>, which may then use exit nodes and reach
        nothing in your tailnet. A rule that lets every device reach everything (
        <code>"src": ["*"]</code>, as in the default policy) covers tagged devices too: give it{' '}
        <code>"autogroup:member"</code> as its source instead. With <code>acls</code> rather than
        grants, the rule is <code>{POLICY_ACL}</code>.
      </li>
      <li>
        <strong>Have an exit node.</strong> Run <code>tailscale set --advertise-exit-node</code> on
        a machine of yours and allow it in the admin console (Machines, the machine's menu, Edit
        route settings, Use as exit node), or add Mullvad's.
      </li>
      <li>
        <strong>Sign in</strong> {signIn} and pick the exit node. This browser's projects share one
        device, <code>elixir-playground</code>; a tagged device's key does not expire.
      </li>
    </ol>
  );
}
