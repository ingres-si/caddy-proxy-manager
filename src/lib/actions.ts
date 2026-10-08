export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  /** Set when a change approval policy turned the change into a change request (ee/approvals). */
  changeRequest?: { id: number; status: string };
  /** The row the action created, when it created one. */
  id?: number;
};

export const INITIAL_ACTION_STATE: ActionState = { status: "idle" };

export function actionSuccess(message?: string): ActionState {
  return {
    status: "success",
    message
  };
}

export function actionError(error: unknown, fallbackMessage: string): ActionState {
  const message = error instanceof Error ? error.message : fallbackMessage;
  return {
    status: "error",
    message
  };
}

export function extractErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error ? error.message : fallbackMessage;
}
