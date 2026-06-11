import { useEffect, useState, useSyncExternalStore } from "react";
import { TriangleAlertIcon } from "lucide-react";
import QRCode from "react-qr-code";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { formatConnectError } from "@/lib/connect-errors";
import {
  connectPayloadFromSdp,
  processConnectInput,
} from "@/lib/connect-handler";
import {
  getConnectAnswerPrompt,
  setConnectAnswerPrompt,
  subscribeConnectAnswerPrompt,
} from "@/lib/connect-answer-prompt";
import { copyToClipboard, readClipboardText } from "@/lib/clipboard";
import {
  buildConnectUri,
  connectUriFitsQr,
  normalizeConnectInput,
} from "@/lib/connect-uri";
import type { Contact } from "@/lib/tauri";
import { buildConnectionOffer } from "@/lib/sdp-exchange";

type ConnectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact;
  localPeerId: string;
};

async function copyLink(label: string, text: string) {
  try {
    await copyToClipboard(text);
    toast.success(`${label} copied`);
  } catch (e) {
    toast.error(String(e));
  }
}

export function ConnectDialog({
  open,
  onOpenChange,
  contact,
  localPeerId,
}: ConnectDialogProps) {
  const [busy, setBusy] = useState(false);
  const [connectUri, setConnectUri] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pasteLink, setPasteLink] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [advancedJson, setAdvancedJson] = useState("");
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const pendingAnswer = useSyncExternalStore(
    subscribeConnectAnswerPrompt,
    getConnectAnswerPrompt,
    () => null,
  );
  const answerUriForContact =
    pendingAnswer?.conversationId === contact.conversationId
      ? pendingAnswer.answerUri
      : null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setPasteLink("");
    setPasteError(null);
    setAdvancedJson("");
    setAdvancedError(null);
    setShowAdvanced(false);
    setConnectUri("");
    setLinkError(null);

    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        const offer = await buildConnectionOffer(
          localPeerId,
          contact.peerId,
          contact.conversationId,
        );
        const uri = await buildConnectUri(
          connectPayloadFromSdp(offer, contact.peerId),
        );
        if (!cancelled) {
          setConnectUri(uri);
          setLinkError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLinkError(formatConnectError(e));
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, contact.peerId, contact.conversationId, localPeerId]);

  async function handlePasteLink() {
    const raw = pasteLink.trim();
    if (!raw) return;

    setBusy(true);
    setPasteError(null);
    try {
      const result = await processConnectInput(raw, localPeerId, contact.peerId);

      if (result.status === "answer_ready") {
        setConnectAnswerPrompt({
          answerUri: result.answerUri,
          remoteDisplayName: result.remoteDisplayName,
          conversationId: result.conversationId,
        });
        toast.success("Send the answer link back to your contact");
        setPasteLink("");
        setPasteError(null);
        return;
      }

      if (result.status === "connected") {
        toast.success("Connected");
        setPasteLink("");
        setPasteError(null);
        onOpenChange(false);
        return;
      }

      setPasteError(result.message);
    } catch (e) {
      setPasteError(formatConnectError(e));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateConnectLink() {
    setBusy(true);
    setConnectUri("");
    setLinkError(null);
    try {
      const offer = await buildConnectionOffer(
        localPeerId,
        contact.peerId,
        contact.conversationId,
      );
      const uri = await buildConnectUri(
        connectPayloadFromSdp(offer, contact.peerId),
      );
      setConnectUri(uri);
    } catch (e) {
      setLinkError(formatConnectError(e));
    } finally {
      setBusy(false);
    }
  }

  const showQr = connectUri ? connectUriFitsQr(connectUri) : false;
  const showAnswerQr = answerUriForContact
    ? connectUriFitsQr(answerUriForContact)
    : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect to {contact.displayName}</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Step 1 — Share your connect link</FieldLabel>
            <FieldDescription>
              Send this link to {contact.displayName}. If they sent you a link
              first, paste theirs in step 2 instead.
            </FieldDescription>
            {busy && !connectUri ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Preparing connect link…
              </div>
            ) : connectUri ? (
              <>
                {showQr && (
                  <div className="flex justify-center rounded-md border bg-white p-3">
                    <QRCode value={connectUri} size={160} />
                  </div>
                )}
                {!showQr && (
                  <FieldDescription>
                    Link is too long for QR — copy or select the text below.
                  </FieldDescription>
                )}
                <Textarea
                  readOnly
                  value={connectUri}
                  className="font-mono text-xs"
                  rows={3}
                  onFocus={(e) => e.target.select()}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copyLink("Connect link", connectUri)}
                  >
                    Copy connect link
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={regenerateConnectLink}
                  >
                    New link
                  </Button>
                </div>
              </>
            ) : (
              <Button disabled={busy} onClick={regenerateConnectLink}>
                {busy ? <Spinner /> : "Retry"}
              </Button>
            )}
            {linkError && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Couldn't create connect link</AlertTitle>
                <AlertDescription>{linkError}</AlertDescription>
              </Alert>
            )}
          </Field>

          {answerUriForContact && (
            <Field>
              <FieldLabel>Your answer link</FieldLabel>
              <FieldDescription>
                Send this link back to {contact.displayName}.
              </FieldDescription>
              {showAnswerQr && (
                <div className="flex justify-center rounded-md border bg-white p-3">
                  <QRCode value={answerUriForContact} size={160} />
                </div>
              )}
              <Textarea
                readOnly
                value={answerUriForContact}
                className="font-mono text-xs"
                rows={3}
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void copyLink("Answer link", answerUriForContact)
                }
              >
                Copy answer link
              </Button>
            </Field>
          )}

          <Field>
            <FieldLabel>Step 2 — Paste their link</FieldLabel>
            <FieldDescription>
              Use Paste from clipboard or paste the full vibe://connect link
              here. Connect links are long — use Copy on the other device, not
              a partial selection.
            </FieldDescription>
            <Textarea
              value={pasteLink}
              onChange={(e) => {
                setPasteLink(e.target.value);
                setPasteError(null);
              }}
              placeholder="vibe://connect?p=…"
              className="font-mono text-xs"
              rows={4}
              aria-invalid={!!pasteError}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setPasteError(null);
                try {
                  const text = await readClipboardText();
                  if (!text?.trim()) {
                    setPasteError(
                      "Clipboard is empty — copy the full connect link on the other device first.",
                    );
                    return;
                  }
                  setPasteLink(normalizeConnectInput(text));
                } catch (e) {
                  setPasteError(formatConnectError(e));
                }
              }}
            >
              Paste from clipboard
            </Button>
            {pasteError && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Couldn't open link</AlertTitle>
                <AlertDescription>{pasteError}</AlertDescription>
              </Alert>
            )}
          </Field>
        </FieldGroup>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            disabled={busy || !pasteLink.trim()}
            onClick={handlePasteLink}
            className="w-full"
          >
            {busy ? <Spinner /> : "Open pasted link"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide" : "Advanced"}: legacy JSON session
          </Button>
          {showAdvanced && (
            <div className="space-y-2">
              <Textarea
                value={advancedJson}
                onChange={(e) => {
                  setAdvancedJson(e.target.value);
                  setAdvancedError(null);
                }}
                placeholder='{"v":1,"peerId":…}'
                className="font-mono text-xs"
                rows={4}
                aria-invalid={!!advancedError}
              />
              {advancedError && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>Couldn't apply session</AlertTitle>
                  <AlertDescription>{advancedError}</AlertDescription>
                </Alert>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !advancedJson.trim()}
                onClick={async () => {
                  setBusy(true);
                  setAdvancedError(null);
                  try {
                    const result = await processConnectInput(
                      advancedJson,
                      localPeerId,
                      contact.peerId,
                    );
                    if (result.status === "answer_ready") {
                      setConnectAnswerPrompt({
                        answerUri: result.answerUri,
                        remoteDisplayName: result.remoteDisplayName,
                        conversationId: result.conversationId,
                      });
                      toast.success("Send the answer link back");
                    } else if (result.status === "connected") {
                      toast.success("Connected");
                      onOpenChange(false);
                    } else {
                      setAdvancedError(result.message);
                    }
                  } catch (e) {
                    setAdvancedError(formatConnectError(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Apply JSON
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
