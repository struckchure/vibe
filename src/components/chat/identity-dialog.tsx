import { useCallback, useEffect, useState } from "react";
import { CopyIcon, DownloadIcon, EyeIcon, EyeOffIcon, UploadIcon } from "lucide-react";
import QRCode from "react-qr-code";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { peerInviteUri } from "@/lib/peer-id";
import * as api from "@/lib/tauri";

type IdentityDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIdentityChanged: () => void;
};

export function IdentityDialog({
  open,
  onOpenChange,
  onIdentityChanged,
}: IdentityDialogProps) {
  const [publicKey, setPublicKey] = useState("");
  const [inviteUri, setInviteUri] = useState("");
  const [showPrivate, setShowPrivate] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [pasteJson, setPasteJson] = useState("");

  const loadIdentity = useCallback(async () => {
    const id = await api.getIdentity();
    setPublicKey(id.publicKey);
    setInviteUri(peerInviteUri(id.publicKey));
    setPrivateKey("");
    setShowPrivate(false);
  }, []);

  useEffect(() => {
    if (open) void loadIdentity();
  }, [open, loadIdentity]);

  const handleRevealPrivate = useCallback(async () => {
    if (showPrivate) {
      setShowPrivate(false);
      setPrivateKey("");
      return;
    }
    try {
      const key = await api.revealPrivateKey();
      setPrivateKey(key);
      setShowPrivate(true);
    } catch (e) {
      toast.error(String(e));
    }
  }, [showPrivate]);

  const handleCopy = useCallback((text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }, []);

  const handleExportPaste = useCallback(async () => {
    try {
      const json = await api.exportIdentityBackup();
      void navigator.clipboard.writeText(json);
      toast.success("Backup JSON copied");
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  const handleExportFile = useCallback(async () => {
    try {
      await api.exportIdentityBackupFile();
      toast.success("Backup saved");
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  const handleImportPaste = useCallback(async () => {
    const json = pasteJson.trim();
    if (!json) return;
    try {
      await api.importIdentityFromPaste(json);
      toast.success("Identity restored");
      setPasteJson("");
      await loadIdentity();
      onIdentityChanged();
    } catch (e) {
      toast.error(String(e));
    }
  }, [pasteJson, loadIdentity, onIdentityChanged]);

  const handleImportFile = useCallback(async () => {
    try {
      await api.importIdentityBackupFile();
      toast.success("Identity restored");
      await loadIdentity();
      onIdentityChanged();
    } catch (e) {
      toast.error(String(e));
    }
  }, [loadIdentity, onIdentityChanged]);

  const handleRegenerate = useCallback(async () => {
    try {
      await api.regenerateIdentity();
      toast.success("New identity created");
      await loadIdentity();
      onIdentityChanged();
    } catch (e) {
      toast.error(String(e));
    }
  }, [loadIdentity, onIdentityChanged]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Identity</DialogTitle>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel>Invite</FieldLabel>
            <div className="flex justify-center rounded-md bg-white p-3">
              {inviteUri ? (
                <QRCode value={inviteUri} size={160} level="M" />
              ) : null}
            </div>
            <div className="flex gap-2">
              <Input
                readOnly
                value={publicKey}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => handleCopy(publicKey, "Public key")}
              >
                <CopyIcon data-icon="inline-start" />
              </Button>
            </div>
            <FieldDescription>
              Scan the QR or share your public key so others can add you.
            </FieldDescription>
          </Field>

          <Separator />

          <Field>
            <FieldLabel>Backup</FieldLabel>
            <FieldDescription>
              Export your keypair to recover this account later. Keep it secret.
            </FieldDescription>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void handleExportFile()}>
                <DownloadIcon data-icon="inline-start" />
                Export to file
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleExportPaste()}>
                <CopyIcon data-icon="inline-start" />
                Copy JSON
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleImportFile()}>
                <UploadIcon data-icon="inline-start" />
                Import from file
              </Button>
            </div>
            <Textarea
              value={pasteJson}
              onChange={(e) => setPasteJson(e.target.value)}
              placeholder='Paste backup JSON (vibe-identity/1)…'
              className="min-h-20 font-mono text-xs"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!pasteJson.trim()}
              onClick={() => void handleImportPaste()}
            >
              Import from paste
            </Button>
          </Field>

          <Separator />

          <Field>
            <FieldLabel>Recovery key</FieldLabel>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRevealPrivate()}
            >
              {showPrivate ? (
                <EyeOffIcon data-icon="inline-start" />
              ) : (
                <EyeIcon data-icon="inline-start" />
              )}
              {showPrivate ? "Hide recovery key" : "Show recovery key"}
            </Button>
            {showPrivate && privateKey ? (
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={privateKey}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => handleCopy(privateKey, "Private key")}
                >
                  <CopyIcon data-icon="inline-start" />
                </Button>
              </div>
            ) : null}
          </Field>

          <Separator />

          <Field>
            <FieldLabel>Advanced</FieldLabel>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  Regenerate identity
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Regenerate identity?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This creates a new peer ID. Your old backup will no longer
                    work and all session contacts will be cleared.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive/10 text-destructive hover:bg-destructive/20"
                    onClick={() => void handleRegenerate()}
                  >
                    Regenerate
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Field>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}
