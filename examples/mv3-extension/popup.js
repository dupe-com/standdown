import { guardActivation } from 'standdown';
import { cjPolicy } from 'standdown/policies';

const state = document.querySelector('#state');
const reason = document.querySelector('#reason');
const activate = document.querySelector('#activate');

let currentDecision = failClosedDecision('popup-state-unknown');

const [tab] = await chrome.tabs.query({
  active: true,
  currentWindow: true,
});

if (tab?.id === undefined) {
  setDecision(failClosedDecision('No active tab was available.'));
} else {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'standdown:shouldStandDown',
      tabId: tab.id,
      url: tab.url,
    });

    setDecision(
      response?.ok === true && response.decision !== undefined
        ? response.decision
        : failClosedDecision('No decision returned.'),
    );
  } catch {
    setDecision(failClosedDecision('Decision query failed.'));
  }
}

activate?.addEventListener('click', (event) => {
  const guard = guardActivation({
    decision: currentDecision,
    userGesture: {
      isTrusted: event.isTrusted,
      type: event.type,
      timeStamp: event.timeStamp,
    },
    benefit: {
      kind: 'cashback',
      description: 'Activate cashback.',
    },
    policy: cjPolicy,
  });

  render(guard.allowed ? 'Activation allowed' : 'Standing down', guard.reason);
});

function setDecision(decision) {
  currentDecision = decision;
  render(
    decision.standDown ? 'Standing down' : 'Clear to offer',
    decision.reason,
  );
}

function failClosedDecision(detail) {
  return {
    standDown: true,
    reason: detail,
    behaviors: [
      'suppress-prompts',
      'no-cookie-write',
      'no-redirect',
      'no-background-tracking',
    ],
  };
}

function render(label, detail) {
  if (state !== null) {
    state.textContent = label;
  }

  if (reason !== null) {
    reason.textContent = detail;
  }
}
