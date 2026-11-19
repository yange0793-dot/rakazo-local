/** Disable the pilot to return to board-only work, including for historical tickets. */
export function ticketReceiptsEnabled(): boolean {
  return process.env.TICKET_WORK_RECEIPTS === "true";
}
