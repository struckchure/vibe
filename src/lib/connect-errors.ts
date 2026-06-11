export function formatConnectError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);

  const lower = raw.toLowerCase();

  if (raw.includes("Cannot apply your own offer link")) {
    return "This is your own connect link — share it with your contact instead of opening it yourself.";
  }
  if (raw.includes("Cannot apply your own answer link")) {
    return "This is your own answer link — send it to the other person so they can finish connecting.";
  }
  if (raw.includes("intended for a different device")) {
    return "This answer link was generated for another device. Ask your contact to send you a new connect link.";
  }
  if (raw.includes("no peer connection for answer")) {
    return "No active connect session on this device. Open Connect for this contact first, then paste their answer link again.";
  }
  if (
    lower.includes("invalid session description") ||
    lower.includes("setremotedescription")
  ) {
    return "This connect link is invalid, expired, or already used. Ask your contact to create a new connect link.";
  }
  if (lower.includes("invalidstateerror") || lower.includes("wrong state")) {
    return "This link no longer matches an active session. Create a new connect link and try again.";
  }
  if (lower.includes("operationerror") && lower.includes("sdp")) {
    return "Could not apply session data from this link. The link may be truncated or corrupted — copy the full link and try again.";
  }
  if (err instanceof DOMException) {
    if (err.name === "InvalidStateError") {
      return "This connect link is expired or already used. Ask for a new link.";
    }
    if (err.message) {
      return err.message;
    }
    return "WebRTC connection failed.";
  }

  return raw || "Something went wrong while connecting.";
}
