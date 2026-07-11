import type { ActivationBenefit, Decision, StanddownPolicy, UserGesture } from './types';
import { validatePolicy } from './validation';

export function guardActivation(req: {
  decision: Decision;
  userGesture: UserGesture;
  benefit: ActivationBenefit;
  policy: StanddownPolicy;
}): { allowed: boolean; reason: string } {
  try {
    validatePolicy(req.policy);
  } catch {
    return { allowed: false, reason: 'malformed-policy' };
  }

  if (req.policy.activation.mode === 'never') {
    return { allowed: false, reason: 'policy-never-activates' };
  }

  if (req.decision.standDown) {
    return { allowed: false, reason: 'active-standdown' };
  }

  if (!isGenuineGesture(req.userGesture)) {
    return { allowed: false, reason: 'missing-trusted-user-gesture' };
  }

  if (req.benefit.description.trim() === '') {
    return { allowed: false, reason: 'missing-user-benefit' };
  }

  const allowedReferrerClasses = req.policy.activation.allowedReferrerClasses;

  if (allowedReferrerClasses !== undefined) {
    if (req.decision.referrerClass === undefined) {
      return { allowed: false, reason: 'missing-referrer-class' };
    }

    if (!isActivationReferrerClass(req.decision.referrerClass)) {
      return { allowed: false, reason: 'referrer-class-disallowed' };
    }

    if (!allowedReferrerClasses.includes(req.decision.referrerClass)) {
      return { allowed: false, reason: 'referrer-class-disallowed' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

function isActivationReferrerClass(
  value: Decision['referrerClass'],
): value is 'own-site' | 'organic' | 'direct' {
  return value === 'own-site' || value === 'organic' || value === 'direct';
}

function isGenuineGesture(gesture: UserGesture): boolean {
  return (
    gesture.isTrusted === true &&
    gesture.type.trim() !== '' &&
    Number.isFinite(gesture.timeStamp)
  );
}
