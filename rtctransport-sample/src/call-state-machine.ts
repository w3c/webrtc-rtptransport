// Call State Machine (JSEP-inspired)
// Manages call lifecycle states and transitions.

export type CallState = 'idle' | 'offering' | 'answering' | 'connecting' | 'connected' | 'closed';

const VALID_TRANSITIONS: Record<CallState, CallState[]> = {
  idle: ['offering', 'answering', 'closed'],
  offering: ['connecting', 'closed'],
  answering: ['connecting', 'closed'],
  connecting: ['connected', 'closed'],
  connected: ['closed'],
  closed: [],
};

export interface CallStateMachineOptions {
  onStateChange?: (newState: CallState, oldState: CallState) => void;
}

export class CallStateMachine {
  state: CallState = 'idle';
  onStateChange: (newState: CallState, oldState: CallState) => void;

  constructor({ onStateChange }: CallStateMachineOptions = {}) {
    this.onStateChange = onStateChange || (() => {});
  }

  transition(newState: CallState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid state transition: ${this.state} → ${newState}`);
    }
    const oldState = this.state;
    this.state = newState;
    this.onStateChange(newState, oldState);
  }

  canTransition(newState: CallState): boolean {
    const allowed = VALID_TRANSITIONS[this.state];
    return allowed && allowed.includes(newState);
  }

  reset(): void {
    if (this.state !== 'closed' && this.state !== 'idle') {
      throw new Error(`Cannot reset from state: ${this.state}`);
    }
    const oldState = this.state;
    this.state = 'idle';
    if (oldState !== 'idle') {
      this.onStateChange('idle', oldState);
    }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.transition('closed');
  }
}
