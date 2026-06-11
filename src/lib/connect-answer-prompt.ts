export type ConnectAnswerPrompt = {
  answerUri: string;
  remoteDisplayName: string;
  conversationId: string;
};

let prompt: ConnectAnswerPrompt | null = null;
const listeners = new Set<() => void>();

export function getConnectAnswerPrompt(): ConnectAnswerPrompt | null {
  return prompt;
}

export function setConnectAnswerPrompt(next: ConnectAnswerPrompt | null) {
  prompt = next;
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeConnectAnswerPrompt(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
