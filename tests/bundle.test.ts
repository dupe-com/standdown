import { describe, expect, it } from 'vitest';
import {
  canonicalPolicyBundlePayload,
  type DomainRule,
  detect,
  type SignedPolicyBundle,
  type StanddownPolicy,
  verifyPolicyBundle,
} from '../src';
import {
  allPolicies,
  cjPolicy,
  experimentalPolicies,
  rakutenPolicy,
  sovrnSkimlinksPolicy,
  universalPolicy,
} from '../src/policies';

const textEncoder = new TextEncoder();

describe('verifyPolicyBundle', () => {
  it('accepts a signed additive bundle', async () => {
    const keyPair = await createSigningKeyPair();
    const updatePolicy = additivePolicy(cjPolicy);
    const bundle = await signedBundle([updatePolicy], keyPair.privateKey);

    await expect(
      verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: true,
      policies: [updatePolicy],
    });
  });

  it('rejects a tampered payload', async () => {
    const keyPair = await createSigningKeyPair();
    const bundle = await signedBundle([cjPolicy], keyPair.privateKey);
    const tampered: SignedPolicyBundle = {
      ...bundle,
      policies: [additivePolicy(cjPolicy)],
    };

    await expect(
      verifyPolicyBundle([cjPolicy], tampered, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'bad-signature',
    });
  });

  it('rejects narrowed detection rules', async () => {
    const keyPair = await createSigningKeyPair();
    const narrowed = clonePolicy(cjPolicy);
    narrowed.detection = {
      ...narrowed.detection,
      landingParams: (narrowed.detection.landingParams ?? []).slice(1),
    };
    const bundle = await signedBundle([narrowed], keyPair.privateKey);

    await expect(
      verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'cj:landing-params-narrowed',
    });
  });

  it('rejects a signed update that strips redirectDomains to an empty set', async () => {
    const keyPair = await createSigningKeyPair();
    const stripped = clonePolicy(sovrnSkimlinksPolicy);
    stripped.detection = {
      ...stripped.detection,
      redirectDomains: [],
    };
    const bundle = await signedBundle([stripped], keyPair.privateKey);

    expect(
      detect(
        {
          url: 'https://merchant.example/product',
          redirectChain: ['https://go.skimresources.com/?id=123'],
          now: 0,
        },
        [sovrnSkimlinksPolicy],
      ).matched,
    ).toHaveLength(1);
    expect(
      detect(
        {
          url: 'https://merchant.example/product',
          redirectChain: ['https://go.skimresources.com/?id=123'],
          now: 0,
        },
        [stripped],
      ).matched,
    ).toHaveLength(0);
    await expect(
      verifyPolicyBundle([sovrnSkimlinksPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'sovrn-skimlinks:redirect-domains-narrowed',
    });
  });

  it('rejects advertiserHosts empty arrays that disable scoped detection', async () => {
    const keyPair = await createSigningKeyPair();
    const emptied = clonePolicy(rakutenPolicy);
    emptied.detection = {
      ...emptied.detection,
      advertiserHosts: [],
    };
    const bundle = await signedBundle([emptied], keyPair.privateKey);

    expect(
      detect(
        {
          url: 'https://merchant.example/product?ranMID=1&ranEAID=2&ranSiteID=3',
          now: 0,
        },
        [rakutenPolicy],
      ).matched,
    ).toHaveLength(1);
    expect(
      detect(
        {
          url: 'https://merchant.example/product?ranMID=1&ranEAID=2&ranSiteID=3',
          now: 0,
        },
        [emptied],
      ).matched,
    ).toHaveLength(0);
    await expect(
      verifyPolicyBundle([rakutenPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'rakuten:advertiser-hosts-narrowed',
    });
  });

  it('rejects shortened stand-down durations', async () => {
    const keyPair = await createSigningKeyPair();
    const shortened = clonePolicy(cjPolicy);
    shortened.standdown = {
      ...shortened.standdown,
      minDurationMs: shortened.standdown.minDurationMs - 1,
    };
    const bundle = await signedBundle([shortened], keyPair.privateKey);

    await expect(
      verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'cj:min-duration-shortened',
    });
  });

  it('rejects activation edits', async () => {
    const keyPair = await createSigningKeyPair();
    const edited = clonePolicy(cjPolicy);
    edited.activation = { mode: 'never' };
    const bundle = await signedBundle([edited], keyPair.privateKey);

    await expect(
      verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'cj:activation-edited',
    });
  });

  it('rejects signatures made by a different key', async () => {
    const signer = await createSigningKeyPair();
    const verifier = await createSigningKeyPair();
    const bundle = await signedBundle([cjPolicy], signer.privateKey);

    await expect(
      verifyPolicyBundle([cjPolicy], bundle, verifier.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'bad-signature',
    });
  });

  it('rejects complex regex domain rules from signed bundles', async () => {
    const keyPair = await createSigningKeyPair();
    const complex = clonePolicy(cjPolicy);
    complex.detection = {
      ...complex.detection,
      redirectDomains: [
        ...(complex.detection.redirectDomains ?? []),
        { pattern: '^(a+)+$', kind: 'regex' },
      ],
    };
    const bundle = await signedBundle([complex], keyPair.privateKey);

    await expect(
      verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk),
    ).resolves.toEqual({
      ok: false,
      violation: 'cj:complex-regex:detection.redirectDomains',
    });
  });

  it.each([
    ['detection.redirectDomains', '^(\\w|\\w)+$'],
    ['detection.redirectDomains', 'a{16}a{16}a{16}b'],
    ['detection.advertiserHosts', '(\\w|\\w)+\\.example$'],
    ['detection.disableHosts', '^shop\\.example$'],
    ['detection.trackingHosts', 'click\\.example'],
  ] as const)('rejects a regex the client does not already ship, in %s (%s)', async (field, pattern) => {
    const keyPair = await createSigningKeyPair();
    const key = field.split('.')[1] as 'redirectDomains' | 'advertiserHosts' | 'disableHosts' | 'trackingHosts';
    const update = clonePolicy(cjPolicy);
    update.detection = {
      ...update.detection,
      [key]: [...(update.detection[key] ?? []), { pattern, kind: 'regex' }],
    };
    const bundle = await signedBundle([update], keyPair.privateKey);

    await expect(verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk)).resolves.toEqual({
      ok: false,
      violation: `cj:new-regex:${field}`,
    });
  });

  it('accepts a regex the client already ships, moved into another field', async () => {
    const keyPair = await createSigningKeyPair();
    const current = clonePolicy(universalPolicy);
    const shipped = (current.detection.redirectDomains ?? []).find((rule) => rule.kind === 'regex') as DomainRule;
    expect(shipped).toBeDefined();
    const update = clonePolicy(current);
    update.detection = { ...update.detection, trackingHosts: [shipped] };
    const bundle = await signedBundle([update], keyPair.privateKey);

    await expect(verifyPolicyBundle([current], bundle, keyPair.publicJwk)).resolves.toMatchObject({ ok: true });
  });

  it('new domains can still be added as suffix rules', async () => {
    const keyPair = await createSigningKeyPair();
    const update = clonePolicy(cjPolicy);
    update.detection = {
      ...update.detection,
      redirectDomains: [...(update.detection.redirectDomains ?? []), { pattern: 'new-tracker.example', kind: 'suffix' }],
    };
    const bundle = await signedBundle([update], keyPair.privateKey);

    await expect(verifyPolicyBundle([cjPolicy], bundle, keyPair.publicJwk)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['disableHosts', 'disable-hosts-narrowed'],
    ['trackingHosts', 'tracking-hosts-narrowed'],
  ] as const)('rejects a bundle that removes %s', async (key, violation) => {
    const keyPair = await createSigningKeyPair();
    const current = clonePolicy(cjPolicy);
    current.detection = { ...current.detection, [key]: [{ pattern: 'shop.example', kind: 'suffix' }] };
    const update = clonePolicy(current);
    update.detection = { ...update.detection, [key]: [] };
    const bundle = await signedBundle([update], keyPair.privateKey);

    await expect(verifyPolicyBundle([current], bundle, keyPair.publicJwk)).resolves.toEqual({
      ok: false,
      violation: `cj:${violation}`,
    });
  });

  it('accepts every bundled policy, so serving them as a bundle keeps working', async () => {
    const keyPair = await createSigningKeyPair();
    const policies = [...allPolicies, ...experimentalPolicies].map(clonePolicy);
    const bundle = await signedBundle(policies, keyPair.privateKey);

    await expect(verifyPolicyBundle(policies, bundle, keyPair.publicJwk)).resolves.toMatchObject({ ok: true });
  });
});

async function createSigningKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  return {
    privateKey: keyPair.privateKey,
    publicJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
  };
}

async function signedBundle(
  policies: readonly StanddownPolicy[],
  privateKey: CryptoKey,
): Promise<SignedPolicyBundle> {
  const unsigned = {
    schemaVersion: 1,
    policies,
  } as const;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    textEncoder.encode(canonicalPolicyBundlePayload(unsigned)),
  );

  return {
    ...unsigned,
    signature: {
      algorithm: 'ECDSA-P256',
      value: bytesToBase64Url(new Uint8Array(signature)),
    },
  };
}

function additivePolicy(policy: StanddownPolicy): StanddownPolicy {
  const next = clonePolicy(policy);
  next.detection = {
    ...next.detection,
    redirectDomains: [
      ...(next.detection.redirectDomains ?? []),
      { pattern: 'new-cj.example', kind: 'suffix' },
    ],
  };
  return next;
}

function clonePolicy(policy: StanddownPolicy): StanddownPolicy {
  return JSON.parse(JSON.stringify(policy)) as StanddownPolicy;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
