import { useSyncExternalStore } from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";

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
import {
  getConnectAnswerPrompt,
  setConnectAnswerPrompt,
  subscribeConnectAnswerPrompt,
} from "@/lib/connect-answer-prompt";
import { copyToClipboard } from "@/lib/clipboard";
import { connectUriFitsQr } from "@/lib/connect-uri";

export function ConnectAnswerDialog() {
  const prompt = useSyncExternalStore(
    subscribeConnectAnswerPrompt,
    getConnectAnswerPrompt,
    () => null,
  );

  if (!prompt) {
    return null;
  }

  const showQr = connectUriFitsQr(prompt.answerUri);

  async function copyLink() {
    try {
      await copyToClipboard(prompt!.answerUri);
      toast.success("Answer link copied");
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          setConnectAnswerPrompt(null);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send answer link to {prompt.remoteDisplayName}</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldDescription>
              Tap Copy answer link below and send the full link back to your
              contact. The link is long — do not copy only part of the text.
            </FieldDescription>
          </Field>
          {showQr ? (
            <Field>
              <FieldLabel>Answer QR</FieldLabel>
              <div className="flex justify-center rounded-md border bg-white p-3">
                <QRCode value={prompt.answerUri} size={160} />
              </div>
            </Field>
          ) : (
            <Field>
              <FieldDescription>
                Link is too long for a QR code — copy or select the text below.
              </FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel>Answer link</FieldLabel>
            <Textarea
              readOnly
              value={prompt.answerUri}
              className="font-mono text-xs"
              rows={3}
              onFocus={(e) => e.target.select()}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button onClick={copyLink}>Copy answer link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
