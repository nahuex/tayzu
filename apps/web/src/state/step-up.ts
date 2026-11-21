/**
 * The step-up dialog store (design D11, Step-up dialog, D12, State, and Q69, Q75).
 *
 * A call answered `step_up_required` asks this store to open the one `StepUpDialog` the
 * shell mounts, and waits for the user to verify or cancel. The store holds only the open
 * request (the answer's optional `reauthorizationUrl`), never a code or a password, and
 * nothing of it reaches storage. It is session-bound: `resetSessionStores()` settles an
 * open request as `cancelled` when the session ends.
 *
 * It also carries, in memory only, the "you are back, repeat the action" notice of the
 * Visma Connect return (Q76): `/step-up/complete` raises it before returning to the stored
 * path, and the shell there shows it once and clears it.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { toApiError } from '../api/errors.js';

export type StepUpOutcome = 'verified' | 'cancelled';

export interface StepUpRequest {
  readonly reauthorizationUrl?: string;
}

export interface StepUpState {
  /** The open request, or `null` when the dialog is closed. */
  readonly request: StepUpRequest | null;
  /** Opens the dialog; resolves once the user verifies or cancels, or the session ends. */
  requestStepUp(request: StepUpRequest): Promise<StepUpOutcome>;
  /** Closes the dialog and resolves the pending request with `outcome`. */
  settleStepUp(outcome: StepUpOutcome): void;
  /** True from the Visma Connect return until the shell takes the notice. */
  readonly returnNotice: boolean;
  /** Asks the next shell to show the "you are back, repeat the action" notice once. */
  raiseReturnNotice(): void;
  /** The shell has taken the notice. */
  clearReturnNotice(): void;
}

interface Pending {
  readonly promise: Promise<StepUpOutcome>;
  readonly resolve: (outcome: StepUpOutcome) => void;
}

/** The open request's promise, kept outside the state: a resolver is not state. */
let pending: Pending | undefined;

export const useStepUpStore: UseBoundStore<StoreApi<StepUpState>> = create<StepUpState>()(
  (set) => ({
    request: null,
    requestStepUp(request) {
      // One dialog: a second call answered step-up while it is open waits for the same
      // answer as the first.
      if (pending !== undefined) return pending.promise;
      let resolve: (outcome: StepUpOutcome) => void = () => undefined;
      const promise = new Promise<StepUpOutcome>((settle) => {
        resolve = settle;
      });
      pending = { promise, resolve };
      set({
        request: Object.freeze(
          request.reauthorizationUrl === undefined
            ? {}
            : { reauthorizationUrl: request.reauthorizationUrl },
        ),
      });
      return promise;
    },
    settleStepUp(outcome) {
      const settled = pending;
      pending = undefined;
      set({ request: null });
      settled?.resolve(outcome);
    },
    returnNotice: false,
    raiseReturnNotice() {
      set({ returnNotice: true });
    },
    clearReturnNotice() {
      set({ returnNotice: false });
    },
  }),
);

/** Resolves a pending request as `cancelled` and clears it and the notice (Q69, Q76). */
export function resetStepUpStore(): void {
  const state = useStepUpStore.getState();
  state.settleStepUp('cancelled');
  state.clearReturnNotice();
}

/**
 * Runs `call`. When it fails with the `step_up_required` kind, opens the dialog; on
 * `verified` it runs `call` exactly once more and answers (or rejects with) that second
 * result as is, never opening the dialog again; on `cancelled` it rejects with the
 * original error. Any other failure is rethrown without a dialog. A page wraps its
 * `mutationFn` with it.
 */
export async function withStepUp<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const answer = toApiError(error);
    if (answer.kind !== 'step_up_required') throw error;
    const outcome = await useStepUpStore
      .getState()
      .requestStepUp(
        answer.reauthorizationUrl === undefined
          ? {}
          : { reauthorizationUrl: answer.reauthorizationUrl },
      );
    if (outcome === 'cancelled') throw error;
    return call();
  }
}
