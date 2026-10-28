import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';
import { useState, type ReactNode } from 'react';
import { TAG } from '@elixir-playground/runtime/tailnet/protocol';

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

// An icon-only button that copies `text` (the policy floats it over its
// code's corner).
export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? 'Copied' : 'Copy';
  return (
    <button
      type="button"
      className={`icon-button copy-button ${className}`}
      title={label}
      aria-label={label}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <RiCheckLine size={15} /> : <RiFileCopyLine size={15} />}
    </button>
  );
}

// Setting Tailscale up for the playground, once per tailnet and browser:
// the policy, an exit node, signing in.
export function SetupSteps({ signIn }: { signIn: ReactNode }) {
  return (
    <ol className="tailscale-steps">
      <li>
        <strong>Allow the playground to use exit nodes.</strong> In the admin console's{' '}
        <a href="https://login.tailscale.com/admin/acls/file" target="_blank" rel="noreferrer">
          Access controls
        </a>
        , add these to your policy file's <code>tagOwners</code> and <code>grants</code>:
        <div className="tailscale-policy">
          <pre>{POLICY}</pre>
          <CopyButton text={POLICY} className="tailscale-policy-copy" />
        </div>
        The playground uses the device tag <code>{TAG}</code>. This grant allows internet access
        through exit nodes. It does not grant access to other tailnet devices. Existing rules with{' '}
        <code>"src": ["*"]</code> also apply to tagged devices. To restrict those rules to
        user-owned devices, change their source to <code>"autogroup:member"</code>. If your policy
        uses <code>acls</code>, use this rule: <code>{POLICY_ACL}</code>.
      </li>
      <li>
        <strong>Configure an exit node.</strong> Run{' '}
        <code>tailscale set --advertise-exit-node</code> on one of your machines. In the admin
        console, open the machine's menu under Machines, select Edit route settings, and enable Use
        as exit node. You can also use a Mullvad exit node.
      </li>
      <li>
        <strong>Sign in</strong> and pick the exit node. This browser's projects share one device,{' '}
        <code>elixir-playground</code>. Key expiry is disabled by default for tagged devices.
        <div className="tailscale-step-action">{signIn}</div>
      </li>
    </ol>
  );
}
